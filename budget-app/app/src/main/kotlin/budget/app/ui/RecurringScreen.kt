package budget.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
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

    val living = list.filter { !it.subscription }
    val subs = list.filter { it.subscription }
    fun hide(r: Recurring) {
        hidden = hidden + r.key
        prefs.hiddenRecurring = hidden
    }

    LazyColumn(Modifier.fillMaxSize()) {
        item { TopBar("매달 나가는 돈 ${list.size}건", onBack) }
        item {
            Text(
                "최근 몇 달 동안 매달 비슷한 날, 비슷한 금액으로 나간 결제예요. 한 가게에 구독이 여러 개면 상품명(없으면 금액)별로 나눠 봐요.",
                fontSize = 13.sp, color = C.sub, lineHeight = 18.sp, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }
        if (list.isEmpty()) {
            item { Panel { Text("아직 찾은 게 없어요. 두 달 이상 기록이 쌓이면 보여요.", color = C.sub, fontSize = 14.sp) } }
        }
        listOf(
            Triple("고정 지출", "집세·관리비·통신비·보험처럼 생활에 쓰는 돈", living),
            Triple("구독", "멤버십·정기구독처럼 끊을 수 있는 것", subs),
        ).forEach { (title, desc, group) ->
            if (group.isEmpty()) return@forEach
            item {
                SectionTitle("$title ${group.size}건 · 한 달 ${won(group.sumOf { it.amount })}")
                Text(
                    "$desc · 이번 달 남은 ${won(RecurringFinder.remaining(group))}",
                    fontSize = 12.sp, color = C.sub, modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 8.dp),
                )
            }
            items(group, key = { it.key }) { r ->
                Column(Modifier.padding(horizontal = 16.dp).background(C.card)) {
                    RecurringRow(r, today) { hide(r) }
                    Divider()
                }
            }
        }
        if (hidden.isNotEmpty()) {
            item {
                Text(
                    "뺀 것 ${hidden.size}개 다시 보기", color = C.accent, fontSize = 14.sp,
                    modifier = Modifier.clickable { hidden = emptySet(); prefs.hiddenRecurring = emptySet() }
                        .padding(horizontal = 20.dp, vertical = 14.dp),
                )
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
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
                "매달 나가는 돈 아님", fontSize = 12.sp, color = C.sub,
                modifier = Modifier.clickable(onClick = onHide).padding(top = 4.dp),
            )
        }
        Text(won(r.amount), fontSize = 15.sp, fontWeight = FontWeight.Bold)
    }
}
