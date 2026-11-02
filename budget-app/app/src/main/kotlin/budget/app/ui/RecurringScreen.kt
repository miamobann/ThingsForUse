package budget.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import budget.app.data.Prefs
import budget.core.Recurring
import budget.core.RecurringFinder
import java.time.LocalDate
import java.time.YearMonth

/** 매달 나가는 고정 지출 목록. 이번 달 아직 안 나간 것부터. */
@Composable
fun RecurringScreen(onBack: () -> Unit) {
    val ctx = LocalContext.current
    val prefs = remember { Prefs(ctx) }
    var hidden by remember { mutableStateOf(prefs.hiddenRecurring) }
    val today = LocalDate.now()
    val list = rememberData(hidden) { repo ->
        val ym = YearMonth.from(today)
        RecurringFinder.find(
            repo.between(ym.minusMonths(6).atDay(1).atStartOfDay(), ym.plusMonths(1).atDay(1).atStartOfDay()),
            today, hidden = hidden,
        )
    } ?: return

    Column(Modifier.fillMaxSize()) {
        TopBar("고정 지출 ${list.size}건", onBack)
        Text(
            "최근 몇 달 동안 매달 비슷한 금액으로 한 번씩 나간 결제예요. 남은 금액 ${won(RecurringFinder.remaining(list))} · 한 달 합계 ${won(list.sumOf { it.amount })}",
            fontSize = 13.sp, color = C.sub, lineHeight = 18.sp, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        )
        if (list.isEmpty()) {
            Panel { Text("아직 찾은 고정 지출이 없어요. 두 달 이상 기록이 쌓이면 보여요.", color = C.sub, fontSize = 14.sp) }
        }
        LazyColumn(Modifier.padding(horizontal = 16.dp).clip(RoundedCornerShape(18.dp)).background(C.card)) {
            items(list, key = { it.key }) { r ->
                RecurringRow(r, today) {
                    hidden = hidden + r.key
                    prefs.hiddenRecurring = hidden
                }
                Divider()
            }
        }
        if (hidden.isNotEmpty()) {
            Text(
                "뺀 가게 ${hidden.size}곳 다시 보기", color = C.accent, fontSize = 14.sp,
                modifier = Modifier.clickable { hidden = emptySet(); prefs.hiddenRecurring = emptySet() }
                    .padding(horizontal = 20.dp, vertical = 14.dp),
            )
        }
    }
}

@Composable
private fun RecurringRow(r: Recurring, today: LocalDate, onHide: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        CategoryBadge(r.category)
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(r.merchant, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1)
            val status = when {
                r.paidThisMonth -> "이번 달 ${r.lastPaid.dayOfMonth}일에 나갔어요"
                r.day < today.dayOfMonth -> "매달 ${r.day}일쯤 · 이번 달 아직 안 나갔어요"
                else -> "매달 ${r.day}일쯤 · ${r.day - today.dayOfMonth}일 뒤"
            }
            Text(status, fontSize = 12.sp, color = if (r.paidThisMonth) C.sub else C.accentDark)
            Text(
                "고정 지출 아님", fontSize = 12.sp, color = C.sub,
                modifier = Modifier.clickable(onClick = onHide).padding(top = 4.dp),
            )
        }
        Text(won(r.amount), fontSize = 15.sp, fontWeight = FontWeight.Bold)
    }
}
