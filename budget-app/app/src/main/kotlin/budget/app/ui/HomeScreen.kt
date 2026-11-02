package budget.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import budget.app.data.Prefs
import budget.core.BudgetStatus
import budget.core.Stats
import budget.core.Tx
import java.time.LocalDate
import java.time.YearMonth

private data class HomeData(
    val month: List<Tx>,
    val spent: Long,
    val prevSameDay: Long,
    val uncategorized: Int,
    val unparsed: Int,
)

@Composable
fun HomeScreen(go: (Screen) -> Unit, openTx: (Long) -> Unit) {
    val ctx = LocalContext.current
    val prefs = Prefs(ctx)
    val today = LocalDate.now()
    val ym = YearMonth.from(today)
    val data = rememberData { repo ->
        val from = ym.minusMonths(1).atDay(1).atStartOfDay()
        val to = ym.plusMonths(1).atDay(1).atStartOfDay()
        val txs = repo.between(from, to)
        val stats = Stats(txs, prefs.includeTransfers)
        HomeData(
            month = txs.filter { YearMonth.from(it.time) == ym },
            spent = stats.monthTotal(ym),
            prevSameDay = stats.totalUntil(ym.minusMonths(1), today.dayOfMonth),
            uncategorized = repo.uncategorized().size,
            unparsed = repo.unparsed().size,
        )
    } ?: return

    LazyColumn(Modifier.fillMaxSize()) {
        item {
            Row(
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 20.dp, bottom = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("${ym.monthValue}월 가계부", fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                SmallButton("파일 올리기") { go(Screen.Import) }
            }
        }
        item { BudgetPanel(data.spent, data.prevSameDay, prefs.monthlyBudget, today) }
        if (data.uncategorized > 0) {
            item {
                Notice("분류 안 된 결제 ${data.uncategorized}건이 있어요", "고르기") { go(Screen.Uncategorized) }
            }
        }
        if (data.unparsed > 0) {
            item {
                Notice("읽지 못한 알림 ${data.unparsed}건 (설정에서 확인)", "보기") { go(Screen.Unparsed) }
            }
        }
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                SectionTitle("이번 달 내역", Modifier.weight(1f))
                Text(
                    "+ 현금 입력", color = C.accent, fontSize = 14.sp, fontWeight = FontWeight.Medium,
                    modifier = Modifier.clickable { go(Screen.AddCash) }.padding(horizontal = 20.dp, vertical = 12.dp),
                )
            }
        }
        if (data.month.isEmpty()) {
            item {
                Panel {
                    Text("아직 이번 달 기록이 없어요.", color = C.sub, fontSize = 14.sp)
                    Text("설정에서 알림 읽기와 문자 권한을 켜 두면 결제할 때마다 자동으로 쌓여요.", color = C.sub, fontSize = 13.sp)
                }
            }
        } else {
            item { Spacer(Modifier.height(0.dp)) }
            items(data.month, key = { it.id }) { t ->
                Box(Modifier.padding(horizontal = 16.dp).background(C.card).padding(horizontal = 16.dp)) {
                    Column {
                        TxRow(t) { openTx(t.id) }
                        Divider()
                    }
                }
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

@Composable
private fun BudgetPanel(spent: Long, prev: Long, budget: Long, today: LocalDate) {
    val b = BudgetStatus.of(budget, spent, today)
    Panel {
        Text("이번 달 쓴 돈", fontSize = 14.sp, color = C.sub)
        Text(won(spent), fontSize = 30.sp, fontWeight = FontWeight.Bold)
        val diff = spent - prev
        val diffText = when {
            prev == 0L && spent == 0L -> "아직 지출이 없어요"
            prev == 0L -> "지난달 같은 날까지는 지출이 없었어요"
            diff > 0 -> "지난달 같은 날보다 ${won(diff)} 더 썼어요 (+${diff * 100 / prev}%)"
            diff < 0 -> "지난달 같은 날보다 ${won(-diff)} 덜 썼어요 (${diff * 100 / prev}%)"
            else -> "지난달 같은 날과 똑같아요"
        }
        Text(diffText, fontSize = 14.sp, color = if (diff > 0) C.warn else C.accentDark, fontWeight = FontWeight.Medium)
        if (budget > 0) {
            Spacer(Modifier.height(8.dp))
            Row(Modifier.fillMaxWidth()) {
                Text("월 예산 ${won(budget)}", fontSize = 13.sp, color = C.sub, modifier = Modifier.weight(1f))
                Text("${(b.ratio * 100).toInt()}% 사용", fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
            Box(Modifier.fillMaxWidth().height(10.dp).clip(RoundedCornerShape(5.dp)).background(C.line)) {
                Box(
                    Modifier.fillMaxWidth(b.ratio.coerceIn(0.0, 1.0).toFloat()).height(10.dp)
                        .clip(RoundedCornerShape(5.dp))
                        .background(if (b.ratio >= 0.8) C.warnBar else C.accent)
                )
            }
            val msg = when {
                b.remaining < 0 -> "예산을 ${won(-b.remaining)} 넘었어요."
                b.ratio >= 0.8 -> "예산까지 ${won(b.remaining)} 남았어요. 남은 ${b.daysLeft}일 동안 하루 ${won(b.perDay)} 이하로 써야 해요."
                else -> null
            }
            if (msg != null) {
                Spacer(Modifier.height(6.dp))
                Text(
                    msg, fontSize = 13.sp, color = C.warnText, lineHeight = 19.sp,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.warnSoft).padding(12.dp),
                )
            }
        }
    }
}

@Composable
private fun Notice(text: String, action: String, onClick: () -> Unit) {
    Row(
        Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp).fillMaxWidth()
            .clip(RoundedCornerShape(14.dp)).background(C.accentSoft).clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, fontSize = 14.sp, color = C.accentDark, modifier = Modifier.weight(1f))
        Text(action, fontSize = 14.sp, color = C.accentDark, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun SmallButton(label: String, onClick: () -> Unit) {
    Text(
        label, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = C.accent,
        modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(C.accentSoft).clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    )
}

@Composable
fun TopBar(title: String, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("‹", fontSize = 26.sp, modifier = Modifier.clickable(onClick = onBack).padding(horizontal = 16.dp, vertical = 6.dp))
        Text(title, fontSize = 18.sp, fontWeight = FontWeight.Bold)
    }
}
