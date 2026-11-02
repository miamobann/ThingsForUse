package budget.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import budget.app.data.Prefs
import budget.app.data.Summary
import java.time.LocalDate
import java.time.YearMonth

@Composable
fun CalendarScreen(openTx: (Long) -> Unit) {
    val ctx = LocalContext.current
    val prefs = Prefs(ctx)
    val today = LocalDate.now()
    var ym by remember { mutableStateOf(YearMonth.from(today)) }
    var picked by remember { mutableStateOf(today) }

    val stats = rememberData(ym) { repo -> Summary.stats(repo, prefs, ym) } ?: return
    val daily = stats.daily(ym)

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("‹", fontSize = 26.sp, color = C.sub, modifier = Modifier.clickable { ym = ym.minusMonths(1) }.padding(16.dp, 4.dp))
            Text("${ym.year}년 ${ym.monthValue}월", fontSize = 20.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
            Text("›", fontSize = 26.sp, color = C.sub, modifier = Modifier.clickable { ym = ym.plusMonths(1) }.padding(16.dp, 4.dp))
        }
        Panel {
            Row(Modifier.fillMaxWidth()) {
                listOf("일", "월", "화", "수", "목", "금", "토").forEachIndexed { i, d ->
                    Text(
                        d, fontSize = 12.sp, textAlign = TextAlign.Center, modifier = Modifier.weight(1f),
                        color = when (i) { 0 -> Color(0xFFB42318); 6 -> Color(0xFF1D4ED8); else -> C.sub },
                    )
                }
            }
            val offset = ym.atDay(1).dayOfWeek.value % 7 // 일요일 = 0
            val cells = List(offset) { null } + (1..ym.lengthOfMonth()).toList()
            cells.chunked(7).forEach { week ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (i in 0 until 7) {
                        val day = week.getOrNull(i)
                        Box(Modifier.weight(1f).height(56.dp)) {
                            if (day != null) {
                                val date = ym.atDay(day)
                                val amt = daily[day] ?: 0
                                val future = date.isAfter(today)
                                val (bg, fg) = when {
                                    amt >= 25_000 -> C.accent to Color.White
                                    amt >= 10_000 -> C.accentMid to C.text
                                    amt > 0 -> C.accentSoft to C.text
                                    else -> C.card to (if (future) C.muted else C.text)
                                }
                                Column(
                                    Modifier.fillMaxSize().clip(RoundedCornerShape(10.dp)).background(bg)
                                        .then(if (date == picked) Modifier.border(2.dp, C.text, RoundedCornerShape(10.dp)) else Modifier)
                                        .clickable { picked = date },
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                    verticalArrangement = Arrangement.Center,
                                ) {
                                    Text("$day", fontSize = 13.sp, color = fg, fontWeight = FontWeight.Medium)
                                    if (amt != 0L) Text(man(amt), fontSize = 10.sp, color = fg, fontWeight = FontWeight.Bold, maxLines = 1)
                                }
                            }
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                Text("적게", fontSize = 11.sp, color = C.sub)
                listOf(C.accentSoft, C.accentMid, C.accent).forEach { Box(Modifier.size(14.dp).clip(RoundedCornerShape(4.dp)).background(it)) }
                Text("많이", fontSize = 11.sp, color = C.sub)
            }
        }
        Spacer(Modifier.height(16.dp))
        val dayTxs = if (YearMonth.from(picked) == ym) stats.forDay(picked) else emptyList()
        Panel {
            Row(Modifier.fillMaxWidth()) {
                Text("${picked.monthValue}월 ${picked.dayOfMonth}일", fontSize = 15.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                Text(won(dayTxs.sumOf { stats.effective(it) }), fontSize = 15.sp, fontWeight = FontWeight.Bold)
            }
            if (dayTxs.isEmpty()) Text("이날은 기록이 없어요", fontSize = 14.sp, color = C.sub)
            dayTxs.forEach { t ->
                Divider()
                TxRow(t) { openTx(t.id) }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}
