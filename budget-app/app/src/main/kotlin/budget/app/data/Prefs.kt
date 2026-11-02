package budget.app.data

import android.content.Context
import budget.core.Categories
import java.time.YearMonth

/** 간단한 설정값 */
class Prefs(ctx: Context) {
    private val p = ctx.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var monthlyBudget: Long
        get() = p.getLong("budget", 500_000)
        set(v) = p.edit().putLong("budget", v).apply()

    /** 송금을 지출 합계에 넣을지 (전체 스위치) */
    var includeTransfers: Boolean
        get() = p.getBoolean("include_transfers", true)
        set(v) = p.edit().putBoolean("include_transfers", v).apply()

    var lockEnabled: Boolean
        get() = p.getBoolean("lock", false)
        set(v) = p.edit().putBoolean("lock", v).apply()

    var categories: List<String>
        get() = p.getString("categories", null)?.split("\n")?.filter { it.isNotBlank() } ?: Categories.DEFAULT
        set(v) = p.edit().putString("categories", v.joinToString("\n")).apply()

    /** '고정 지출 아님'으로 뺀 가게 */
    var hiddenRecurring: Set<String>
        get() = p.getStringSet("hidden_recurring", emptySet())!!.toSet()
        set(v) = p.edit().putStringSet("hidden_recurring", v).apply()

    fun alertsSent(ym: YearMonth): Set<Int> =
        p.getStringSet("alerts_$ym", emptySet())!!.mapNotNull { it.toIntOrNull() }.toSet()

    fun markAlertSent(ym: YearMonth, level: Int) {
        p.edit().putStringSet("alerts_$ym", alertsSent(ym).map { it.toString() }.toSet() + level.toString()).apply()
    }
}
