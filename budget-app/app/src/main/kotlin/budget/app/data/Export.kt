package budget.app.data

import android.content.Context
import android.net.Uri
import budget.core.Channel
import budget.core.AppCsv
import budget.core.Kind
import budget.core.MoneyFlow
import budget.core.Source
import budget.core.Tx
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * 내보내기 두 가지.
 * - CSV: 분석 프로그램용. 한 줄에 한 건, 엑셀에서 바로 열리게 BOM 포함.
 * - 백업 JSON: 거래 + 분류 규칙 + 설정. 복원에 쓴다.
 *
 * 설정에서 구글 드라이브의 파일을 한 번 연결해 두면, 내역이 바뀔 때마다 그 파일을 덮어쓴다.
 * (안드로이드 파일 선택기로 받은 권한으로 쓰기 때문에 이 앱 자체는 인터넷 권한이 없다.)
 */
object Export {

    private val DATE = DateTimeFormatter.ofPattern("yyyy-MM-dd")
    private val TIME = DateTimeFormatter.ofPattern("HH:mm")

    val CSV_HEADER = listOf(
        "id", "날짜", "시각", "금액", "가게명", "원래가게명", "카테고리", "결제수단", "할부",
        "송금여부", "지출포함여부", "취소됨", "메모", "출처", "종류", "상계대상", "귀속월",
    )

    fun payMethod(t: Tx): String = when (t.source.channel) {
        Channel.CARD -> "현대카드"
        Channel.BANK -> "농협"
        Channel.NAVERPAY -> if (t.linkedNaverPay) "현대카드" else "네이버페이"
        Channel.MANUAL -> "현금"
    }

    fun csv(txs: List<Tx>, cutoff: Int): String {
        val sb = StringBuilder("﻿")
        sb.append(CSV_HEADER.joinToString(",")).append("\r\n")
        for (row in rows(txs, cutoff)) sb.append(row.joinToString(",") { cell(it) }).append("\r\n")
        return sb.toString()
    }

    /**
     * CSV·시트 공통: 한 건을 17개 열로.
     * 15 종류(결제/환불/출금/입금), 16 상계대상(이 환불·입금이 돌려준 결제 id), 17 귀속월(기준일 이후 수입은 다음 달).
     */
    fun rows(txs: List<Tx>, cutoff: Int): List<List<String>> = txs.sortedWith(compareBy({ it.time }, { it.id })).map { t ->
            val amount = if (t.kind == Kind.CANCEL || t.kind == Kind.INCOME) -t.amount else t.amount
            listOf(
                t.id.toString(),
                t.time.format(DATE),
                if (t.timeKnown) t.time.format(TIME) else "",
                amount.toString(),
                t.merchant,
                t.originalMerchant,
                t.category ?: "",
                payMethod(t),
                if (t.installmentMonths > 1) t.installmentMonths.toString() else "",
                if (t.kind == Kind.TRANSFER) "Y" else "N",
                if (t.includeInSpending) "Y" else "N",
                if (t.cancelled) "Y" else "N",
                t.memo,
                t.source.label,
                AppCsv.KIND_LABELS.getValue(t.kind),
                t.offsetOf?.toString() ?: "",
                MoneyFlow.budgetMonth(t, cutoff).toString(),
            )
        }

    private fun cell(s: String): String =
        if (s.any { it == ',' || it == '"' || it == '\n' || it == '\r' }) "\"" + s.replace("\"", "\"\"") + "\"" else s

    // ---- 백업 / 복원 ----

    fun backupJson(repo: Repository, prefs: Prefs): String {
        val txs = JSONArray()
        repo.all().forEach { t ->
            txs.put(JSONObject().apply {
                put("id", t.id); put("time", t.time.toString()); put("timeKnown", t.timeKnown)
                put("amount", t.amount); put("merchant", t.merchant); put("originalMerchant", t.originalMerchant)
                put("category", t.category ?: JSONObject.NULL); put("source", t.source.name); put("kind", t.kind.name)
                put("cancelled", t.cancelled); put("include", t.includeInSpending)
                put("approvalNo", t.approvalNo ?: JSONObject.NULL); put("installment", t.installmentMonths)
                put("linkedNaverPay", t.linkedNaverPay); put("memo", t.memo); put("raw", t.raw)
                put("offsetOf", t.offsetOf ?: JSONObject.NULL)
            })
        }
        val rules = JSONObject()
        repo.rules().forEach { (k, v) -> rules.put(k, v) }
        return JSONObject().apply {
            put("app", "budget"); put("version", 1); put("savedAt", LocalDateTime.now().toString())
            put("budget", prefs.monthlyBudget); put("includeTransfers", prefs.includeTransfers)
            put("budgetAuto", prefs.budgetAuto); put("cutoff", prefs.cutoffDay)
            put("categories", JSONArray(prefs.categories))
            put("rules", rules); put("tx", txs)
        }.toString()
    }

    /** 백업 파일로 전부 바꾼다. 읽은 거래 수를 돌려준다. */
    fun restore(repo: Repository, prefs: Prefs, json: String): Int {
        val o = JSONObject(json)
        require(o.optString("app") == "budget") { "가계부 백업 파일이 아니에요" }
        val arr = o.getJSONArray("tx")
        repo.transaction {
            repo.deleteAll()
            for (i in 0 until arr.length()) {
                val t = arr.getJSONObject(i)
                val id = t.optLong("id", 0)
                val tx = Tx(
                        id = id,
                        time = LocalDateTime.parse(t.getString("time")),
                        timeKnown = t.optBoolean("timeKnown", true),
                        amount = t.getLong("amount"),
                        merchant = t.getString("merchant"),
                        originalMerchant = t.optString("originalMerchant", t.getString("merchant")),
                        category = if (t.isNull("category")) null else t.getString("category"),
                        source = runCatching { Source.valueOf(t.getString("source")) }.getOrDefault(Source.MANUAL),
                        kind = runCatching { Kind.valueOf(t.getString("kind")) }.getOrDefault(Kind.PAYMENT),
                        cancelled = t.optBoolean("cancelled"),
                        includeInSpending = t.optBoolean("include", true),
                        approvalNo = if (t.isNull("approvalNo")) null else t.optString("approvalNo"),
                        installmentMonths = t.optInt("installment"),
                        linkedNaverPay = t.optBoolean("linkedNaverPay"),
                        memo = t.optString("memo"),
                        raw = t.optString("raw"),
                        offsetOf = if (t.isNull("offsetOf")) null else t.optLong("offsetOf"),
                    )
                    .let { // 예전 백업의 '입금' 카테고리는 구분 안 한 입금으로
                        if (it.kind == Kind.INCOME && it.category == budget.core.Categories.INCOME) it.copy(category = MoneyFlow.defaultIncomeCategory(it.merchant)) else it
                    }
                if (id > 0) repo.insertWithId(tx) else repo.insert(tx)
            }
            val rules = o.optJSONObject("rules")
            rules?.keys()?.forEach { k -> rules.getString(k).takeIf { it != budget.core.Categories.INCOME }?.let { repo.putRule(k, it) } }
        }
        prefs.monthlyBudget = o.optLong("budget", prefs.monthlyBudget)
        prefs.includeTransfers = o.optBoolean("includeTransfers", prefs.includeTransfers)
        prefs.budgetAuto = o.optBoolean("budgetAuto", prefs.budgetAuto)
        prefs.cutoffDay = o.optInt("cutoff", prefs.cutoffDay)
        o.optJSONArray("categories")?.let { a -> prefs.categories = (0 until a.length()).map { a.getString(it) } }
        repo.changed()
        return arr.length()
    }

    // ---- 연결된 파일에 자동 저장 ----

    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private var pending: ScheduledFuture<*>? = null

    /** 내역이 바뀌면 5초 뒤에 한 번 저장 (연달아 바뀌면 마지막에 한 번만) */
    @Synchronized
    fun scheduleAutoSave(ctx: Context) {
        val links = AutoSaveLinks(ctx)
        if (links.csv == null && links.backup == null) return
        pending?.cancel(false)
        pending = scheduler.schedule({ saveNow(ctx) }, 5, TimeUnit.SECONDS)
    }

    /** @return 실패하면 이유, 성공하면 null */
    fun saveNow(ctx: Context): String? {
        val repo = Repository.get(ctx)
        val links = AutoSaveLinks(ctx)
        var error: String? = null
        links.csv?.let { uri ->
            runCatching { write(ctx, uri, csv(repo.all(), Prefs(ctx).cutoffDay)) }.onFailure { error = "CSV 저장 실패: ${it.message}" }
        }
        links.backup?.let { uri ->
            runCatching { write(ctx, uri, backupJson(repo, Prefs(ctx))) }.onFailure { error = "백업 저장 실패: ${it.message}" }
        }
        links.lastResult = error ?: "저장됨 ${LocalDateTime.now().format(DateTimeFormatter.ofPattern("M/d HH:mm"))}"
        return error
    }

    fun write(ctx: Context, uri: Uri, text: String) {
        ctx.contentResolver.openOutputStream(uri, "wt")!!.use { it.write(text.toByteArray(Charsets.UTF_8)) }
    }
}

/** 설정에서 연결한 드라이브 파일 위치 */
class AutoSaveLinks(ctx: Context) {
    private val p = ctx.applicationContext.getSharedPreferences("autosave", Context.MODE_PRIVATE)

    var csv: Uri?
        get() = p.getString("csv", null)?.let(Uri::parse)
        set(v) = p.edit().putString("csv", v?.toString()).apply()

    var backup: Uri?
        get() = p.getString("backup", null)?.let(Uri::parse)
        set(v) = p.edit().putString("backup", v?.toString()).apply()

    var lastResult: String?
        get() = p.getString("last", null)
        set(v) = p.edit().putString("last", v).apply()
}
