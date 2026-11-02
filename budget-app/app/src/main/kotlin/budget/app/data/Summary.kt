package budget.app.data

import budget.core.MoneyFlow
import budget.core.Stats
import java.time.YearMonth

/** 통계를 만들 때 쓰는 공통 설정: 상계 합계(전체 기간), 기준일, 송금 포함 여부 */
object Summary {
    /** [from]~[to] 달을 볼 수 있는 Stats. 기준일 때문에 앞 달 수입도 같이 읽는다. */
    fun stats(repo: Repository, prefs: Prefs, from: YearMonth, to: YearMonth = from): Stats = Stats(
        repo.between(from.minusMonths(1).atDay(1).atStartOfDay(), to.plusMonths(1).atDay(1).atStartOfDay()),
        prefs.includeTransfers, repo.offsetSums(), prefs.cutoffDay,
    )

    /** 그 달 예산: 자동이면 수입 − 저축, 아니면(또는 수입이 아직 없으면) 직접 정한 금액 */
    fun budget(prefs: Prefs, stats: Stats, ym: YearMonth): Long =
        MoneyFlow.budget(prefs.budgetAuto, prefs.monthlyBudget, stats.income(ym), stats.savings(ym))
}
