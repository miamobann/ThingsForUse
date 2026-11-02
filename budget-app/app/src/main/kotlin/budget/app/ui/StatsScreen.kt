package budget.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import budget.app.data.Prefs
import budget.core.Stats
import java.time.YearMonth

@Composable
fun StatsScreen() {
    val ctx = LocalContext.current
    val prefs = Prefs(ctx)
    var ym by remember { mutableStateOf(YearMonth.now()) }
    val txs = rememberData(ym) { repo ->
        repo.between(ym.minusMonths(5).atDay(1).atStartOfDay(), ym.plusMonths(1).atDay(1).atStartOfDay())
    } ?: return
    val stats = Stats(txs, prefs.includeTransfers)
    val cats = stats.byCategory(ym)
    val total = cats.sumOf { it.second }
    val months = stats.monthly(ym, 6)
    val budget = prefs.monthlyBudget

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("‹", fontSize = 26.sp, color = C.sub, modifier = Modifier.clickable { ym = ym.minusMonths(1) }.padding(16.dp, 4.dp))
            Text("${ym.year}년 ${ym.monthValue}월 통계", fontSize = 20.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
            Text("›", fontSize = 26.sp, color = C.sub, modifier = Modifier.clickable { ym = ym.plusMonths(1) }.padding(16.dp, 4.dp))
        }

        Panel {
            Text("카테고리별 비율", fontSize = 15.sp, fontWeight = FontWeight.Bold)
            if (total <= 0) {
                Text("이 달은 지출이 없어요", fontSize = 14.sp, color = C.sub)
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(150.dp), contentAlignment = Alignment.Center) {
                        Canvas(Modifier.size(150.dp)) {
                            val stroke = 22.dp.toPx()
                            val inset = stroke / 2
                            var start = -90f
                            cats.forEach { (name, v) ->
                                val sweep = 360f * v / total
                                drawArc(
                                    C.category(name), start, sweep, useCenter = false,
                                    topLeft = Offset(inset, inset), size = Size(size.width - stroke, size.height - stroke),
                                    style = Stroke(stroke),
                                )
                                start += sweep
                            }
                        }
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("합계", fontSize = 11.sp, color = C.sub)
                            Text(man(total), fontSize = 15.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                    Spacer(Modifier.width(16.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        cats.take(7).forEach { (name, v) ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(C.category(name)))
                                Spacer(Modifier.width(8.dp))
                                Text(name, fontSize = 13.sp, modifier = Modifier.weight(1f))
                                Text("${v * 100 / total}%", fontSize = 13.sp, color = C.sub)
                            }
                        }
                    }
                }
                Spacer(Modifier.height(6.dp))
                cats.forEach { (name, v) ->
                    Divider()
                    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                        Text(name, fontSize = 14.sp, modifier = Modifier.weight(1f))
                        Text(won(v), fontSize = 14.sp, fontWeight = FontWeight.Medium)
                    }
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        Panel {
            Row(Modifier.fillMaxWidth()) {
                Text("월별 총지출", fontSize = 15.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                if (budget > 0) Text("점선: 예산 ${man(budget)}", fontSize = 12.sp, color = C.sub)
            }
            val maxV = maxOf(months.maxOf { it.second }, budget, 1L)
            val barArea = 130.dp
            Box(Modifier.fillMaxWidth().height(barArea)) {
                Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Bottom) {
                    months.forEachIndexed { i, (_, v) ->
                        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(man(v), fontSize = 10.sp, color = C.sub, maxLines = 1)
                            Box(
                                Modifier.fillMaxWidth().height(barArea * 0.82f * (v.coerceAtLeast(0).toFloat() / maxV))
                                    .clip(RoundedCornerShape(topStart = 6.dp, topEnd = 6.dp))
                                    .background(if (i == months.lastIndex) C.accent else C.accentMid)
                            )
                        }
                    }
                }
                if (budget > 0) {
                    Canvas(Modifier.fillMaxSize()) {
                        val y = size.height - size.height * 0.82f * (budget.toFloat() / maxV)
                        drawLine(
                            C.warn, Offset(0f, y), Offset(size.width, y), strokeWidth = 1.5.dp.toPx(),
                            pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 8f)),
                        )
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                months.forEach { (m, _) ->
                    Text("${m.monthValue}월", fontSize = 12.sp, color = C.sub, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}
