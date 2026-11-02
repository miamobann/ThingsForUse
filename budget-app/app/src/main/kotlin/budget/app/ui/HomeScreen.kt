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
import androidx.compose.foundation.layout.width
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
import budget.app.data.Summary
import budget.core.Kind
import budget.core.BudgetStatus
import budget.core.DuplicateCheck
import budget.core.Recurring
import budget.core.RecurringFinder
import budget.core.Tx
import java.time.LocalDate
import java.time.YearMonth

private data class HomeData(
    val recent: List<Tx>,
    val spent: Long,
    val prevSameDay: Long,
    val income: Long,
    val savings: Long,
    val budget: Long,
    val budgetFromIncome: Boolean,
    val topCategories: List<Pair<String, Long>>,
    val uncategorizedPay: Int,
    val uncategorizedIncome: Int,
    val openRefunds: Int,
    val unparsed: Int,
    val recurring: List<Recurring>,
    val duplicates: Int,
)

/**
 * 홈: 위에서부터 쓸 수 있는 돈 → 이번 달 흐름(수입·저축·지출·남은 돈) → 확인할 것 → 많이 쓴 카테고리 → 최근 내역.
 */
@Composable
fun HomeScreen(go: (Screen) -> Unit, openTx: (Long) -> Unit) {
    val ctx = LocalContext.current
    val prefs = Prefs(ctx)
    val today = LocalDate.now()
    val ym = YearMonth.from(today)
    var showAll by remember { mutableStateOf(false) }
    val data = rememberData { repo ->
        val stats = Summary.stats(repo, prefs, ym.minusMonths(1), ym)
        val recurring = RecurringFinder.find(
            repo.between(ym.minusMonths(6).atDay(1).atStartOfDay(), ym.plusMonths(1).atDay(1).atStartOfDay()), today, hidden = prefs.hiddenRecurring,
        )
        val uncategorized = repo.uncategorized()
        val income = stats.income(ym)
        HomeData(
            recent = repo.between(ym.atDay(1).atStartOfDay(), ym.plusMonths(1).atDay(1).atStartOfDay()),
            spent = stats.monthTotal(ym),
            prevSameDay = stats.totalUntil(ym.minusMonths(1), today.dayOfMonth),
            income = income,
            savings = stats.savings(ym),
            budget = Summary.budget(prefs, stats, ym),
            budgetFromIncome = prefs.budgetAuto && income > 0,
            topCategories = stats.byCategory(ym).take(3),
            uncategorizedPay = uncategorized.count { it.kind != Kind.INCOME },
            uncategorizedIncome = uncategorized.count { it.kind == Kind.INCOME },
            openRefunds = repo.openRefunds().size,
            unparsed = repo.unparsed().size,
            recurring = recurring,
            duplicates = DuplicateCheck.suspects(repo.all(), prefs.dismissedDuplicates).size,
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
        item { SpendablePanel(data, ym, today) }
        item { FlowPanel(data) }

        // 확인할 것
        val checks = buildList<Triple<String, String, Screen>> {
            if (data.uncategorizedIncome > 0) add(Triple("구분 안 한 입금 ${data.uncategorizedIncome}건 (수입? 돌려받은 돈?)", "고르기", Screen.Uncategorized))
            if (data.uncategorizedPay > 0) add(Triple("분류 안 된 결제 ${data.uncategorizedPay}건", "고르기", Screen.Uncategorized))
            if (data.openRefunds > 0) add(Triple("결제와 상계 안 한 돌려받은 돈·환불 ${data.openRefunds}건", "보기", Screen.Refunds))
            if (data.duplicates > 0) add(Triple("중복 의심 결제 ${data.duplicates}건", "확인", Screen.Duplicates))
            if (data.unparsed > 0) add(Triple("읽지 못한 알림 ${data.unparsed}건", "보기", Screen.Unparsed))
            if (data.recurring.isNotEmpty()) {
                val left = data.recurring.filter { !it.paidThisMonth }
                add(
                    Triple(
                        if (left.isEmpty()) "고정 지출 ${data.recurring.size}건 모두 나갔어요"
                        else "남은 고정 지출 ${left.size}건 · ${won(RecurringFinder.remaining(data.recurring))}",
                        "보기", Screen.Recurring,
                    )
                )
            }
        }
        if (checks.isNotEmpty()) {
            item { SectionTitle("확인할 것") }
            items(checks, key = { it.first }) { (text, action, screen) -> Notice(text, action) { go(screen) } }
        }

        if (data.topCategories.isNotEmpty()) {
            item { SectionTitle("많이 쓴 곳") }
            item {
                Panel {
                    val max = data.topCategories.first().second.coerceAtLeast(1)
                    data.topCategories.forEach { (name, v) ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CategoryBadge(name, 28)
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Row {
                                    Text(name, fontSize = 14.sp, modifier = Modifier.weight(1f))
                                    Text(won(v), fontSize = 14.sp, fontWeight = FontWeight.Medium)
                                }
                                Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(C.line)) {
                                    Box(Modifier.fillMaxWidth(v.toFloat() / max).height(6.dp).clip(RoundedCornerShape(3.dp)).background(C.category(name)))
                                }
                            }
                        }
                    }
                }
            }
        }

        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                SectionTitle("최근 내역", Modifier.weight(1f))
                Text(
                    "+ 직접 입력", color = C.accent, fontSize = 14.sp, fontWeight = FontWeight.Medium,
                    modifier = Modifier.clickable { go(Screen.AddCash) }.padding(horizontal = 20.dp, vertical = 12.dp),
                )
            }
        }
        if (data.recent.isEmpty()) {
            item {
                Panel {
                    Text("아직 이번 달 기록이 없어요.", color = C.sub, fontSize = 14.sp)
                    Text("설정에서 알림 읽기를 켜 두면 결제할 때마다 자동으로 쌓여요.", color = C.sub, fontSize = 13.sp)
                }
            }
        } else {
            val shown = if (showAll) data.recent else data.recent.take(5)
            items(shown, key = { it.id }) { t ->
                Box(Modifier.padding(horizontal = 16.dp).background(C.card).padding(horizontal = 16.dp)) {
                    Column {
                        TxRow(t) { openTx(t.id) }
                        Divider()
                    }
                }
            }
            if (data.recent.size > 5) {
                item {
                    Text(
                        if (showAll) "접기" else "이번 달 내역 ${data.recent.size}건 모두 보기",
                        color = C.accent, fontSize = 14.sp, fontWeight = FontWeight.Medium,
                        modifier = Modifier.fillMaxWidth().clickable { showAll = !showAll }.padding(horizontal = 20.dp, vertical = 14.dp),
                    )
                }
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

/** 쓸 수 있는 돈: 예산 중 얼마 썼고 얼마 남았는지, 남은 날 하루 얼마 */
@Composable
private fun SpendablePanel(d: HomeData, ym: YearMonth, today: LocalDate) {
    val b = BudgetStatus.of(d.budget, d.spent, today)
    Panel {
        if (d.budget > 0) {
            Text("${ym.monthValue}월 쓸 수 있는 돈 ${man(d.budget)}", fontSize = 14.sp, color = C.sub)
            Row(verticalAlignment = Alignment.Bottom) {
                Text(
                    if (b.remaining >= 0) "${won(b.remaining)} 남음" else "${won(-b.remaining)} 넘음",
                    fontSize = 28.sp, fontWeight = FontWeight.Bold, color = if (b.remaining < 0) C.warn else C.text,
                    modifier = Modifier.weight(1f),
                )
                Text("${won(d.spent)} 사용", fontSize = 14.sp, color = C.sub)
            }
            Box(Modifier.fillMaxWidth().height(10.dp).clip(RoundedCornerShape(5.dp)).background(C.line)) {
                Box(
                    Modifier.fillMaxWidth(b.ratio.coerceIn(0.0, 1.0).toFloat()).height(10.dp)
                        .clip(RoundedCornerShape(5.dp))
                        .background(if (b.ratio >= 0.8) C.warnBar else C.accent)
                )
            }
            Text(
                if (b.remaining > 0) "남은 ${b.daysLeft}일 동안 하루 ${won(b.perDay)}씩 쓸 수 있어요" else "이번 달 쓸 수 있는 돈을 다 썼어요",
                fontSize = 14.sp, fontWeight = FontWeight.Medium, color = if (b.ratio >= 0.8) C.warnText else C.accentDark,
            )
            Text(
                if (d.budgetFromIncome) "수입 ${man(d.income)} − 저축 ${man(d.savings)} 기준" else "설정에서 정한 예산 기준 (이번 달 수입이 들어오면 자동으로 바뀌어요)",
                fontSize = 12.sp, color = C.sub,
            )
        } else {
            Text("이번 달 쓴 돈", fontSize = 14.sp, color = C.sub)
            Text(won(d.spent), fontSize = 28.sp, fontWeight = FontWeight.Bold)
        }
        val diff = d.spent - d.prevSameDay
        val prev = d.prevSameDay
        val diffText = when {
            prev == 0L && d.spent == 0L -> "아직 지출이 없어요"
            prev == 0L -> "지난달 같은 날까지는 지출이 없었어요"
            diff > 0 -> "지난달 같은 날보다 ${won(diff)} 더 썼어요 (+${diff * 100 / prev}%)"
            diff < 0 -> "지난달 같은 날보다 ${won(-diff)} 덜 썼어요 (${diff * 100 / prev}%)"
            else -> "지난달 같은 날과 똑같아요"
        }
        Spacer(Modifier.height(2.dp))
        Text(diffText, fontSize = 13.sp, color = if (diff > 0) C.warn else C.sub)
    }
}

/** 이번 달 흐름 한 줄: 수입 · 저축 · 지출 · 남은 돈 */
@Composable
private fun FlowPanel(d: HomeData) {
    val left = d.income - d.savings - d.spent
    Row(
        Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp).fillMaxWidth()
            .clip(RoundedCornerShape(18.dp)).background(C.card).padding(vertical = 14.dp),
    ) {
        listOf(
            "수입" to (if (d.income > 0) man(d.income) else "-"),
            "저축" to man(d.savings),
            "지출" to man(d.spent),
            "남은 돈" to (if (d.income > 0) man(left) else "-"),
        ).forEach { (label, v) ->
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(label, fontSize = 12.sp, color = C.sub)
                Text(
                    v, fontSize = 15.sp, fontWeight = FontWeight.Bold, maxLines = 1,
                    color = if (label == "남은 돈" && d.income > 0 && left < 0) C.warn else C.text,
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
