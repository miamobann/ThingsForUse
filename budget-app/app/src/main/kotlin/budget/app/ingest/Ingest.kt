package budget.app.ingest

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import budget.app.BudgetApp
import budget.app.data.Prefs
import budget.app.data.Repository
import budget.app.ui.MainActivity
import budget.app.ui.won
import budget.core.BudgetAlert
import budget.core.HyundaiCardMessageParser
import budget.core.AppCsv
import budget.core.AppCsv.toNewTx
import budget.core.Categories
import budget.core.Matcher
import budget.core.Merchants
import budget.core.NaverPayParser
import budget.core.NhBankSmsParser
import budget.core.Parsed
import budget.core.Source
import budget.core.Stats
import budget.core.Tx
import budget.core.toTx
import java.time.LocalDateTime
import java.time.YearMonth

/** 알림·문자·파일·직접 입력이 모두 지나가는 곳. 중복 확인 → 저장 → 분류 요청·예산 알림. */
object Ingest {

    /** 문자 앱 (삼성 메시지, 구글 메시지, 기본 문자 앱 등) */
    fun isSmsApp(pkg: String) = pkg.contains("messaging") || pkg.contains("mms") || pkg.endsWith(".message")

    private fun isCardApp(pkg: String) = pkg.contains("hyundaicard")
    private fun isNaverPayApp(pkg: String) = pkg.contains("naverfin") || pkg == "com.nhn.android.search"

    /** 알림 리스너에서 호출 (작업 스레드) */
    fun fromNotification(ctx: Context, pkg: String, title: String?, text: String, postedAt: LocalDateTime) {
        val repo = Repository.get(ctx)
        when {
            isSmsApp(pkg) -> {
                // 문자 권한 없이 문자 앱 알림으로 읽는다. 제목은 보낸 사람(예: 농협), 내용은 문자 본문.
                fromSms(ctx, listOfNotNull(title, text).joinToString("\n"), postedAt)
            }
            isCardApp(pkg) -> {
                val p = HyundaiCardMessageParser.parse(title, text, postedAt, Source.CARD_NOTI)
                if (p != null) record(ctx, p) else if (text.contains("원")) {
                    repo.addUnparsed("현대카드 알림", listOfNotNull(title, text).joinToString("\n"), postedAt)
                    repo.changed()
                }
            }
            isNaverPayApp(pkg) -> {
                val joined = listOfNotNull(title, text).joinToString("\n")
                if (!joined.contains("결제")) return
                val p = NaverPayParser.parse(title, text, postedAt)
                if (p != null) record(ctx, p) else if (joined.contains("원")) {
                    repo.addUnparsed("네이버페이 알림", joined, postedAt)
                    repo.changed()
                }
            }
        }
    }

    fun fromSms(ctx: Context, body: String, receivedAt: LocalDateTime) {
        val repo = Repository.get(ctx)
        when {
            NhBankSmsParser.looksLikeNh(body) -> {
                val p = NhBankSmsParser.parse(body, receivedAt)
                if (p != null) record(ctx, p) else if (body.contains("출금")) {
                    repo.addUnparsed("농협 문자", body, receivedAt)
                    repo.changed()
                }
            }
            HyundaiCardMessageParser.looksLikeCard(body) -> {
                val p = HyundaiCardMessageParser.parse(null, body, receivedAt, Source.CARD_SMS)
                if (p != null) record(ctx, p) else {
                    repo.addUnparsed("현대카드 문자", body, receivedAt)
                    repo.changed()
                }
            }
        }
    }

    /** 실시간으로 들어온 결제 한 건 처리 (작업 스레드에서 호출) */
    fun record(ctx: Context, p: Parsed) {
        val repo = Repository.get(ctx)
        val prefs = Prefs(ctx)
        val before = monthSpent(repo, prefs, YearMonth.now())
        val nearby = repo.between(p.time.minusDays(3), p.time.plusDays(3))
        val saved = apply(repo, p, Matcher.decide(p, nearby))
        repo.changed()

        if (saved != null && saved.category == null && !saved.cancelled) askCategory(ctx, saved)
        val after = monthSpent(repo, prefs, YearMonth.now())
        if (after != before) checkBudget(ctx, prefs, after)
    }

    /** 직접 입력 */
    fun addManual(ctx: Context, p: Parsed, category: String) {
        val repo = Repository.get(ctx)
        repo.writer.execute {
            repo.insert(p.toTx(0, category))
            repo.changed()
            checkBudget(ctx, Prefs(ctx), monthSpent(repo, Prefs(ctx), YearMonth.now()))
        }
    }

    /**
     * 파일에서 읽은 여러 건을 한 번에 넣는다. 분류 알림은 보내지 않는다(홈의 '미분류'에서 모아서 고른다).
     * @return 새로 저장된 건수
     */
    fun importRows(ctx: Context, rows: List<Parsed>): Int {
        val repo = Repository.get(ctx)
        if (rows.isEmpty()) return 0
        val from = rows.minOf { it.time }.minusDays(3)
        val to = rows.maxOf { it.time }.plusDays(3)
        val consumed = mutableSetOf<Long>()
        var added = 0
        repo.transaction {
            for (p in rows) {
                val nearby = repo.between(from, to)
                val d = Matcher.decide(p, nearby, consumed)
                val saved = apply(repo, p, d)
                when (d) {
                    Matcher.Decision.Insert -> {
                        added++
                        saved?.let { consumed += it.id }
                    }
                    is Matcher.Decision.Duplicate -> consumed += d.existing.id
                    else -> Unit
                }
            }
        }
        repo.changed()
        return added
    }

    /**
     * 분석 프로그램 등에서 정리한 가계부 CSV 넣기. 카테고리·메모·지출 포함 여부를 그대로 쓰고,
     * 이미 기록된 결제는 건너뛴다. 가게별 분류는 아직 기억이 없으면 기억해 둔다.
     */
    fun importCsv(ctx: Context, rows: List<AppCsv.Row>): Int {
        val repo = Repository.get(ctx)
        if (rows.isEmpty()) return 0
        val from = rows.minOf { it.parsed.time }.minusDays(3)
        val to = rows.maxOf { it.parsed.time }.plusDays(3)
        val consumed = mutableSetOf<Long>()
        // 파일 안의 줄끼리는 이미 정리된 내역이라 서로 비교하지 않는다 (같은 금액이라도 시각이 다르면 다른 결제)
        val inserted = mutableSetOf<Long>()
        var added = 0
        repo.transaction {
            for (row in rows) {
                val p = row.parsed.copy(cancelled = false)
                val d = Matcher.decide(p, repo.between(from, to).filter { it.id !in inserted }, consumed)
                if (d == Matcher.Decision.Insert) {
                    val id = repo.insert(row.toNewTx())
                    inserted += id
                    added++
                    val c = row.category
                    if (c != null && row.includeInSpending && c != Categories.TRANSFER &&
                        !Merchants.isPaymentAgentOnly(row.merchant) && repo.ruleFor(row.merchant) == null
                    ) repo.putRule(Merchants.key(row.merchant), c)
                } else {
                    if (d is Matcher.Decision.Duplicate) {
                        consumed += d.existing.id
                        if (d.existing.category == null && row.category != null) repo.update(d.existing.copy(category = row.category))
                    } else apply(repo, p, d)
                }
            }
        }
        repo.changed()
        return added
    }

    /** 결정대로 DB를 바꾸고, 새로 생기거나 이름이 바뀐 거래를 돌려준다 */
    private fun apply(repo: Repository, p: Parsed, d: Matcher.Decision): Tx? = when (d) {
        Matcher.Decision.Insert -> {
            val category = repo.ruleFor(p.merchant) ?: Merchants.suggestCategory(p.merchant, p.kind)
            val tx = p.toTx(0, category)
            tx.copy(id = repo.insert(tx))
        }
        is Matcher.Decision.Duplicate -> {
            if ((d.approvalNo != null && d.existing.approvalNo == null) || d.amount != null) {
                repo.update(d.existing.copy(approvalNo = d.existing.approvalNo ?: d.approvalNo, amount = d.amount ?: d.existing.amount))
            }
            null
        }
        is Matcher.Decision.AttachNaverPay -> {
            // 카드에는 대행사 이름만 있었으니 네이버페이의 실제 가게 이름으로 바꾸고 분류도 다시 해 본다
            val name = Merchants.displayName(d.merchant)
            val category = d.existing.category.takeUnless { Merchants.isPaymentAgentOnly(d.existing.merchant) }
                ?: repo.ruleFor(name) ?: Merchants.suggestCategory(name, d.existing.kind)
            val t = d.existing.copy(merchant = name, linkedNaverPay = true, category = category)
            repo.update(t)
            t
        }
        is Matcher.Decision.AttachCard -> {
            repo.update(
                d.existing.copy(
                    originalMerchant = d.cardMerchant, linkedNaverPay = true, amount = d.amount,
                    approvalNo = d.approvalNo ?: d.existing.approvalNo,
                    memo = when {
                        d.amount < d.existing.amount -> "네이버페이 포인트 ${d.existing.amount - d.amount}원 사용"
                        d.amount > d.existing.amount -> "배송비 등 ${d.amount - d.existing.amount}원 포함"
                        else -> d.existing.memo
                    },
                )
            )
            null
        }
        is Matcher.Decision.Cancel -> {
            repo.update(d.target.copy(cancelled = true))
            null
        }
        Matcher.Decision.Ignore -> null
    }

    fun monthSpent(repo: Repository, prefs: Prefs, ym: YearMonth): Long {
        val txs = repo.between(ym.atDay(1).atStartOfDay(), ym.plusMonths(1).atDay(1).atStartOfDay())
        return Stats(txs, prefs.includeTransfers).monthTotal(ym)
    }

    private fun checkBudget(ctx: Context, prefs: Prefs, spent: Long) {
        val ym = YearMonth.now()
        val budget = prefs.monthlyBudget
        val level = BudgetAlert.due(budget, spent, prefs.alertsSent(ym)) ?: return
        prefs.markAlertSent(ym, level)
        val text = if (level >= 100) "이번 달 예산 ${won(budget)}을 넘었어요. 지금까지 ${won(spent)}"
        else "예산의 $level%를 썼어요. 남은 돈 ${won(budget - spent)}"
        notify(ctx, BudgetApp.CHANNEL_BUDGET, 1000 + ym.monthValue, "예산 알림", text, null)
    }

    private fun askCategory(ctx: Context, t: Tx) {
        notify(
            ctx, BudgetApp.CHANNEL_CATEGORY, (t.id % 100_000).toInt(),
            "처음 보는 가게예요: ${t.merchant}", "${won(t.amount)} · 눌러서 카테고리를 골라주세요", t.id,
        )
    }

    private fun notify(ctx: Context, channel: String, id: Int, title: String, text: String, txId: Long?) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val intent = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (txId != null) putExtra(MainActivity.EXTRA_TX, txId)
        }
        val pi = PendingIntent.getActivity(ctx, id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = android.app.Notification.Builder(ctx, channel)
            .setSmallIcon(budget.app.R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(android.app.Notification.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify(id, n)
    }

}
