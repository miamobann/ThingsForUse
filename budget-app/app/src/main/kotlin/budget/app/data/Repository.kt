package budget.app.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import budget.core.Categories
import budget.core.Kind
import budget.core.Merchants
import budget.core.MoneyFlow
import budget.core.Offset
import budget.core.Rules
import budget.core.Source
import budget.core.Tx
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.time.LocalDateTime
import java.util.concurrent.Executors

private const val NOTI_LOG_SQL =
    "CREATE TABLE IF NOT EXISTS noti_log(id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, origin TEXT NOT NULL, " +
        "text TEXT NOT NULL, result TEXT NOT NULL, tx_id INTEGER)"

private class DbHelper(ctx: Context) : SQLiteOpenHelper(ctx, "budget.db", null, 3) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE tx(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                time TEXT NOT NULL, time_known INTEGER NOT NULL,
                amount INTEGER NOT NULL, merchant TEXT NOT NULL, original_merchant TEXT NOT NULL,
                category TEXT, source TEXT NOT NULL, kind TEXT NOT NULL,
                cancelled INTEGER NOT NULL DEFAULT 0, include_in_spending INTEGER NOT NULL DEFAULT 1,
                approval_no TEXT, installment INTEGER NOT NULL DEFAULT 0,
                linked_np INTEGER NOT NULL DEFAULT 0, memo TEXT NOT NULL DEFAULT '', raw TEXT NOT NULL DEFAULT '',
                offset_of INTEGER)"""
        )
        db.execSQL("CREATE INDEX tx_time ON tx(time)")
        db.execSQL("CREATE TABLE rule(merchant_key TEXT PRIMARY KEY, category TEXT NOT NULL)")
        db.execSQL("CREATE TABLE unparsed(id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, origin TEXT NOT NULL, text TEXT NOT NULL)")
        db.execSQL(NOTI_LOG_SQL)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) db.execSQL(NOTI_LOG_SQL)
        if (oldVersion < 3) {
            // 상계 연결 열. 입금은 이제 수입/돌려받은 돈/내 계좌 이동으로 나눈다:
            // 예전 '입금' 카테고리는 지우고(사람 이름이면 돌려받은 돈), '입금'으로 기억한 규칙도 지운다.
            db.execSQL("ALTER TABLE tx ADD COLUMN offset_of INTEGER")
            db.execSQL("DELETE FROM rule WHERE category = '입금'")
            db.rawQuery("SELECT id, merchant FROM tx WHERE kind = 'INCOME' AND category = '입금'", null).use { c ->
                while (c.moveToNext()) {
                    db.update("tx", ContentValues().apply {
                        val cat = MoneyFlow.defaultIncomeCategory(c.getString(1))
                        if (cat == null) putNull("category") else put("category", cat)
                    }, "id = ?", arrayOf(c.getLong(0).toString()))
                }
            }
        }
    }
}

data class Unparsed(val id: Long, val time: LocalDateTime, val origin: String, val text: String)

/** 받은 결제 알림·문자 원문과 처리 결과 */
data class NotiLog(val id: Long, val time: LocalDateTime, val origin: String, val text: String, val result: String, val txId: Long?)

/**
 * 앱 데이터 전부. 쓰기는 한 줄짜리 작업 스레드에서만 해서 알림·문자가 동시에 와도 순서대로 처리된다.
 * 화면은 [version]이 바뀌면 다시 읽는다.
 */
class Repository private constructor(ctx: Context) {
    private val db = DbHelper(ctx.applicationContext).writableDatabase
    val writer = Executors.newSingleThreadExecutor()

    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> = _version
    /** 내역이 바뀌면 부른다: 화면 새로고침 + 드라이브 자동 저장 예약 */
    var onChanged: (() -> Unit)? = null
    fun changed() {
        _version.value = _version.value + 1
        onChanged?.invoke()
    }

    // ---- 거래 ----

    fun all(): List<Tx> = query("SELECT * FROM tx ORDER BY time DESC, id DESC")

    fun between(from: LocalDateTime, to: LocalDateTime): List<Tx> =
        query("SELECT * FROM tx WHERE time >= ? AND time < ? ORDER BY time DESC, id DESC", from.toString(), to.toString())

    fun byId(id: Long): Tx? = query("SELECT * FROM tx WHERE id = ?", id.toString()).firstOrNull()

    /** 분류 안 된 결제와 구분 안 한 입금 */
    fun uncategorized(): List<Tx> =
        query("SELECT * FROM tx WHERE category IS NULL AND cancelled = 0 ORDER BY time DESC")

    /** 보류로 둔 기록 */
    fun held(): List<Tx> =
        query("SELECT * FROM tx WHERE category = ? AND cancelled = 0 ORDER BY time DESC", Categories.HOLD)

    /** 같은 가게·단어 규칙을 만들 때 같이 채울 기록: 미분류 + 보류 */
    private fun undecided(): List<Tx> = uncategorized() + held()

    /** 아직 결제와 연결하지 않은 돌려받은 돈·환불 (최근 [days]일) */
    fun openRefunds(days: Long = 92): List<Tx> =
        query(
            "SELECT * FROM tx WHERE kind IN ('INCOME', 'CANCEL') AND cancelled = 0 AND offset_of IS NULL AND time >= ? ORDER BY time DESC",
            LocalDateTime.now().minusDays(days).toString(),
        ).filter(Offset::isOpen)

    /** 결제 id → 상계로 돌려받은 금액 합 (전체 기간) */
    fun offsetSums(): Map<Long, Long> {
        val out = mutableMapOf<Long, Long>()
        db.rawQuery("SELECT offset_of, SUM(amount) FROM tx WHERE offset_of IS NOT NULL AND cancelled = 0 GROUP BY offset_of", null).use { c ->
            while (c.moveToNext()) out[c.getLong(0)] = c.getLong(1)
        }
        return out
    }

    /** 이 결제에 연결된 환불·입금 */
    fun linkedTo(id: Long): List<Tx> = query("SELECT * FROM tx WHERE offset_of = ? ORDER BY time", id.toString())

    fun insert(t: Tx): Long = db.insert("tx", null, values(t))

    /** 백업 복원용: id를 그대로 살려서 넣는다 (시트의 분류 자료가 id에 붙어 있어서) */
    fun insertWithId(t: Tx): Long =
        db.insertWithOnConflict("tx", null, values(t).apply { put("id", t.id) }, SQLiteDatabase.CONFLICT_REPLACE)

    /** 앱 안에서 카테고리가 바뀌면 부른다: 시트로 보낼 분류 수정 기록 */
    var onCategoryEdited: ((Long, String?) -> Unit)? = null

    /** @param fromSync 시트에서 받아온 분류를 넣을 때는 다시 시트로 보내지 않는다 */
    fun update(t: Tx, fromSync: Boolean = false) {
        val hook = onCategoryEdited
        val before = if (hook != null && !fromSync) byId(t.id)?.category else null
        db.update("tx", values(t), "id = ?", arrayOf(t.id.toString()))
        if (hook != null && !fromSync && before != t.category) hook(t.id, t.category)
    }

    /** 지우는 결제에 연결돼 있던 환불·입금은 연결만 푼다 */
    fun delete(id: Long) {
        db.update("tx", ContentValues().apply { putNull("offset_of") }, "offset_of = ?", arrayOf(id.toString()))
        db.delete("tx", "id = ?", arrayOf(id.toString()))
    }

    fun deleteAll() {
        db.delete("tx", null, null)
        db.delete("rule", null, null)
        db.delete("unparsed", null, null)
        db.delete("noti_log", null, null)
    }

    /**
     * 카테고리를 정한다. remember면 같은 가게(입금이면 같은 보낸 사람)의 다음 기록부터 자동으로 쓰고,
     * 아직 분류 안 된 같은 가게 기록도 한꺼번에 채운다. 수입·저축 등을 고르면 지출에서 빠진다.
     * byAmount면 이 가게의 같은 금액에만 기억한다(치지직 4,900원 = 구독처럼). 금액 규칙이 가게 규칙보다 먼저.
     * 결제대행사 이름만 있는 가게(네이버파이낸셜 등)는 기억하지 않는다.
     */
    fun setCategory(t: Tx, category: String, remember: Boolean, byAmount: Boolean = false, word: String? = null) {
        update(MoneyFlow.withCategory(t, category))
        if (category == Categories.HOLD) return
        val w = word?.trim()?.lowercase().orEmpty()
        if (remember && w.isNotEmpty()) {
            putRule(Rules.wordKey(w), category)
            onWordRuleEdited?.invoke(w, category)
            undecided().filter { Rules.textOf(it).contains(w) }.forEach { update(MoneyFlow.withCategory(it, category)) }
        } else if (remember && !Merchants.isPaymentAgentOnly(t.merchant)) {
            val key = MoneyFlow.ruleKey(t.merchant, t.kind)
            putRule(if (byAmount) Rules.amountKey(key, t.amount) else key, category)
            undecided().filter { MoneyFlow.ruleKey(it.merchant, it.kind) == key && (!byAmount || it.amount == t.amount) }
                .forEach { update(MoneyFlow.withCategory(it, ruleFor(it) ?: category)) }
        }
    }

    /** 앱에서 단어 규칙을 만들면 부른다: 시트로 보낼 규칙 기록 */
    var onWordRuleEdited: ((String, String) -> Unit)? = null

    /** 이 기록에 맞는 기억: 단어 규칙 → 가게+금액 → 가게 */
    fun ruleFor(t: Tx): String? = ruleFor(t.merchant, t.kind, t.amount, Rules.textOf(t))

    /** 단어 규칙(text가 있을 때) → 금액 규칙 → 가게 규칙 순서로 찾는다 */
    fun ruleFor(merchant: String, kind: Kind, amount: Long? = null, text: String? = null): String? {
        if (text != null && kind != Kind.INCOME) Rules.matchWord(wordRules(), text)?.let { return it }
        if (Merchants.isPaymentAgentOnly(merchant)) return null
        val keys = if (amount != null) Rules.lookupKeys(merchant, kind, amount) else listOf(MoneyFlow.ruleKey(merchant, kind))
        for (k in keys) {
            db.rawQuery("SELECT category FROM rule WHERE merchant_key = ?", arrayOf(k)).use { c -> if (c.moveToFirst()) return c.getString(0) }
        }
        return null
    }

    /** 단어 규칙: 단어(소문자) → 대분류 */
    fun wordRules(): Map<String, String> {
        val out = mutableMapOf<String, String>()
        db.rawQuery("SELECT merchant_key, category FROM rule WHERE merchant_key LIKE 'w:%'", null).use { c ->
            while (c.moveToNext()) out[c.getString(0).removePrefix(Rules.WORD_PREFIX)] = c.getString(1)
        }
        return out
    }

    /** 시트의 단어 규칙 목록으로 바꾼다 (분석 화면에서 만들거나 지운 것 반영) */
    fun replaceWordRules(rules: Map<String, String>) {
        db.delete("rule", "merchant_key LIKE 'w:%'", null)
        rules.forEach { (w, c) -> putRule(Rules.wordKey(w), c) }
    }

    fun rules(): Map<String, String> {
        val out = mutableMapOf<String, String>()
        db.rawQuery("SELECT merchant_key, category FROM rule", null).use { c ->
            while (c.moveToNext()) out[c.getString(0)] = c.getString(1)
        }
        return out
    }

    fun putRule(key: String, category: String) {
        db.insertWithOnConflict("rule", null, ContentValues().apply {
            put("merchant_key", key)
            put("category", category)
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    // ---- 읽지 못한 알림 ----

    fun addUnparsed(origin: String, text: String, time: LocalDateTime = LocalDateTime.now()) {
        db.insert("unparsed", null, ContentValues().apply {
            put("time", time.toString())
            put("origin", origin)
            put("text", text)
        })
    }

    fun unparsed(): List<Unparsed> {
        val out = mutableListOf<Unparsed>()
        db.rawQuery("SELECT id, time, origin, text FROM unparsed ORDER BY id DESC LIMIT 200", null).use { c ->
            while (c.moveToNext()) out += Unparsed(c.getLong(0), LocalDateTime.parse(c.getString(1)), c.getString(2), c.getString(3))
        }
        return out
    }

    // ---- 결제 알림 기록 (최근 180일) ----

    fun addLog(origin: String, text: String, result: String, txId: Long?, time: LocalDateTime = LocalDateTime.now()) {
        db.insert("noti_log", null, ContentValues().apply {
            put("time", time.toString())
            put("origin", origin)
            put("text", text)
            put("result", result)
            if (txId == null) putNull("tx_id") else put("tx_id", txId)
        })
        db.delete("noti_log", "time < ?", arrayOf(LocalDateTime.now().minusDays(180).toString()))
    }

    fun logs(limit: Int = 500): List<NotiLog> {
        val out = mutableListOf<NotiLog>()
        db.rawQuery("SELECT id, time, origin, text, result, tx_id FROM noti_log ORDER BY id DESC LIMIT $limit", null).use { c ->
            while (c.moveToNext()) out += NotiLog(
                c.getLong(0), LocalDateTime.parse(c.getString(1)), c.getString(2), c.getString(3), c.getString(4),
                if (c.isNull(5)) null else c.getLong(5),
            )
        }
        return out
    }

    fun deleteLogs() {
        db.delete("noti_log", null, null)
    }

    fun deleteUnparsed(id: Long?) {
        if (id == null) db.delete("unparsed", null, null) else db.delete("unparsed", "id = ?", arrayOf(id.toString()))
    }

    fun <T> transaction(block: () -> T): T {
        db.beginTransaction()
        try {
            val r = block()
            db.setTransactionSuccessful()
            return r
        } finally {
            db.endTransaction()
        }
    }

    // ---- 내부 ----

    private fun query(sql: String, vararg args: String): List<Tx> {
        val out = mutableListOf<Tx>()
        db.rawQuery(sql, arrayOf(*args)).use { c -> while (c.moveToNext()) out += read(c) }
        return out
    }

    private fun read(c: Cursor): Tx {
        fun s(n: String) = c.getString(c.getColumnIndexOrThrow(n))
        fun l(n: String) = c.getLong(c.getColumnIndexOrThrow(n))
        fun b(n: String) = l(n) != 0L
        return Tx(
            id = l("id"),
            time = LocalDateTime.parse(s("time")),
            timeKnown = b("time_known"),
            amount = l("amount"),
            merchant = s("merchant"),
            originalMerchant = s("original_merchant"),
            category = c.getColumnIndexOrThrow("category").let { if (c.isNull(it)) null else c.getString(it) },
            source = runCatching { Source.valueOf(s("source")) }.getOrDefault(Source.MANUAL),
            kind = runCatching { Kind.valueOf(s("kind")) }.getOrDefault(Kind.PAYMENT),
            cancelled = b("cancelled"),
            includeInSpending = b("include_in_spending"),
            approvalNo = c.getColumnIndexOrThrow("approval_no").let { if (c.isNull(it)) null else c.getString(it) },
            installmentMonths = l("installment").toInt(),
            linkedNaverPay = b("linked_np"),
            memo = s("memo"),
            raw = s("raw"),
            offsetOf = c.getColumnIndexOrThrow("offset_of").let { if (c.isNull(it)) null else c.getLong(it) },
        )
    }

    private fun values(t: Tx) = ContentValues().apply {
        put("time", t.time.withSecond(0).withNano(0).toString())
        put("time_known", if (t.timeKnown) 1 else 0)
        put("amount", t.amount)
        put("merchant", t.merchant)
        put("original_merchant", t.originalMerchant)
        if (t.category == null) putNull("category") else put("category", t.category)
        put("source", t.source.name)
        put("kind", t.kind.name)
        put("cancelled", if (t.cancelled) 1 else 0)
        put("include_in_spending", if (t.includeInSpending) 1 else 0)
        if (t.approvalNo == null) putNull("approval_no") else put("approval_no", t.approvalNo)
        put("installment", t.installmentMonths)
        put("linked_np", if (t.linkedNaverPay) 1 else 0)
        put("memo", t.memo)
        put("raw", t.raw)
        if (t.offsetOf == null) putNull("offset_of") else put("offset_of", t.offsetOf)
    }

    companion object {
        @Volatile
        private var instance: Repository? = null
        fun get(ctx: Context): Repository = instance ?: synchronized(this) {
            instance ?: Repository(ctx).also { instance = it }
        }
    }
}
