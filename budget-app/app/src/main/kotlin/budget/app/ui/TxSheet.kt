package budget.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import java.time.LocalTime
import androidx.compose.ui.unit.sp
import budget.app.data.Prefs
import budget.app.data.Repository
import budget.core.Autocomplete
import budget.core.Categories
import budget.core.Installment
import budget.core.Source
import budget.core.Kind
import budget.core.Offset
import budget.core.Merchants
import budget.core.MoneyFlow
import budget.core.Tx

/** 거래 한 건: 카테고리 고르기, 지출 포함 여부, 메모, 삭제 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TxSheet(id: Long, onClose: () -> Unit) {
    val tx = rememberData(id) { it.byId(id) }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onClose, sheetState = sheet, containerColor = C.card) {
        if (tx == null) {
            Text("불러오는 중…", Modifier.padding(24.dp))
        } else {
            TxEditor(tx, onClose)
        }
    }
}

@Composable
private fun TxEditor(t: Tx, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val repo = Repository.get(ctx)
    val prefs = Prefs(ctx)
    val agentOnly = Merchants.isPaymentAgentOnly(t.merchant)
    var category by remember(t.id) { mutableStateOf(t.category) }
    var keepRule by remember(t.id) { mutableStateOf(!agentOnly) }
    var byAmount by remember(t.id) { mutableStateOf(false) }
    var word by remember(t.id) { mutableStateOf("") }
    var include by remember(t.id) { mutableStateOf(t.includeInSpending) }
    var memo by remember(t.id) { mutableStateOf(t.memo) }
    // 직접 입력 기록만: 가게명·금액·날짜·시각 고치기 (자동 기록은 짝짓기에 쓰여서 그대로 둔다)
    val manual = t.source == Source.MANUAL
    var name by remember(t.id) { mutableStateOf(t.merchant) }
    var amountText by remember(t.id) { mutableStateOf(t.amount.toString()) }
    var date by remember(t.id) { mutableStateOf(t.time.toLocalDate()) }
    var time by remember(t.id) { mutableStateOf(if (t.timeKnown) t.time.toLocalTime() else null) }
    val all = rememberData { it.all() } ?: emptyList()
    var hiddenMerchants by remember { mutableStateOf(prefs.hiddenMerchantSuggestions) }
    var hiddenMemos by remember { mutableStateOf(prefs.hiddenMemoSuggestions) }
    val merchantCands = remember(all, hiddenMerchants) { Autocomplete.merchants(all, hiddenMerchants) }
    val memoCands = remember(all, hiddenMemos) { Autocomplete.memos(all, hiddenMemos) }
    var newCategory by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }

    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).navigationBarsPadding(),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (t.category == Categories.HOLD) Text("보류한 결제예요. 지금 골라도 되고 나중에 모아서 정해도 돼요.", fontSize = 13.sp, color = C.accent, fontWeight = FontWeight.Medium)
            if (t.category == null) Text(
                if (t.kind == Kind.INCOME) "처음 보는 입금이에요" else "처음 보는 가게예요",
                fontSize = 13.sp, color = C.accent, fontWeight = FontWeight.Medium,
            )
            Text(t.merchant, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Text(
                listOfNotNull(
                    sign(t) + won(t.amount),
                    if (t.timeKnown) t.time.format(MD_HM) else t.time.format(MD),
                    t.source.label,
                    if (t.cancelled) "취소됨" else null,
                ).joinToString(" · "),
                fontSize = 15.sp, color = C.sub,
            )
            if (t.originalMerchant != t.merchant) Text("카드 표시: ${t.originalMerchant}", fontSize = 12.sp, color = C.sub)
            Installment.of(t)?.let { i ->
                Text(
                    "${i.months}개월 할부 · 전체 ${won(i.total)} · 월 ${won(i.perMonth)}\n${i.paid}회 냄 · 남은 ${won(i.remaining)} (${i.remainingMonths}개월)",
                    fontSize = 13.sp, color = C.accentDark, lineHeight = 19.sp,
                )
            }
        }

        if (manual) {
            AutoField(
                name, { name = it }, "가게 이름", merchantCands,
                onHide = { prefs.hiddenMerchantSuggestions = hiddenMerchants + it; hiddenMerchants = prefs.hiddenMerchantSuggestions },
            )
            OutlinedTextField(
                amountText.toLongOrNull()?.let { "%,d".format(it) } ?: "", { v -> amountText = v.filter { it.isDigit() } },
                Modifier.fillMaxWidth(), label = { Text("금액 (원)") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
            DateTimeInput(date, time, onDate = { date = it }, onTime = { time = it }, quickChips = false)
        }

        val income = t.kind == Kind.INCOME
        if (income) {
            Text("어떤 입금인가요?", fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MoneyFlow.INCOME_CHOICES.forEach { c -> Chip(c, category == c, Modifier.weight(1f)) { category = c } }
            }
            Text(
                when (category) {
                    MoneyFlow.EARNED -> "번 돈이에요(월급·부수입·이자). 기준일(${prefs.cutoffDay}일) 이후 받으면 다음 달 수입으로 세요."
                    MoneyFlow.RETURNED -> "더치페이·환불처럼 돌려받은 돈이에요. 아래에서 원래 결제와 연결하면 그 결제가 줄어든 금액으로 세져요."
                    MoneyFlow.OWN -> "내 다른 계좌에서 옮긴 돈이에요(적금 만기 포함). 수입도 지출도 아니에요."
                    else -> "골라 두면 다음부터 이 사람이 보낸 돈은 자동으로 같은 구분이 돼요."
                },
                fontSize = 12.sp, color = C.sub, lineHeight = 17.sp,
            )
        } else {
            Text("카테고리", fontSize = 15.sp, fontWeight = FontWeight.Medium)
            val choices = prefs.categories + (if (t.kind == Kind.TRANSFER || category in MoneyFlow.OUT_CHOICES) MoneyFlow.OUT_CHOICES else emptyList())
            choices.chunked(3).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { c ->
                        Chip(c, category == c, Modifier.weight(1f)) {
                            category = c
                            if (MoneyFlow.isFlowCategory(c)) include = false
                            else if (MoneyFlow.isFlowCategory(t.category)) include = true
                        }
                    }
                    repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
            if (t.kind == Kind.TRANSFER) {
                Text("적금 등은 '저축', 내 다른 계좌로 보낸 돈은 '내 계좌 이동'을 고르면 지출에서 빠져요.", fontSize = 12.sp, color = C.sub, lineHeight = 17.sp)
            }
        }
        if (!income && newCategory == null) {
            Text("+ 새 카테고리 만들기", color = C.accent, fontSize = 14.sp, modifier = Modifier.clickable { newCategory = "" }.padding(vertical = 4.dp))
        } else if (!income) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(newCategory!!, { newCategory = it.take(10) }, Modifier.weight(1f), singleLine = true, label = { Text("새 카테고리 이름") })
                Spacer(Modifier.padding(4.dp))
                Button(onClick = {
                    val name = newCategory!!.trim()
                    if (name.isNotEmpty() && name !in prefs.categories) prefs.categories = prefs.categories + name
                    if (name.isNotEmpty()) category = name
                    newCategory = null
                }) { Text("추가") }
            }
        }

        if (agentOnly) {
            Text(
                "'${t.merchant}'은 결제대행사 이름이라 실제 가게를 알 수 없어서, 이 가게로 기억하지 않고 매번 물어봐요.",
                fontSize = 13.sp, color = C.sub, lineHeight = 18.sp,
            )
        } else {
            Row(Modifier.fillMaxWidth().clickable { keepRule = !keepRule }, verticalAlignment = Alignment.CenterVertically) {
                Checkbox(keepRule, { keepRule = it })
                Text(if (income) "다음부터 이 사람이 보낸 돈은 자동으로 같은 구분" else "다음부터 이 가게는 자동으로 같은 카테고리로 분류", fontSize = 14.sp)
            }
            if (keepRule && !income) {
                Row(Modifier.fillMaxWidth().padding(start = 24.dp).clickable { byAmount = !byAmount }, verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(byAmount, { byAmount = it })
                    Text("${won(t.amount)}일 때만 (같은 가게라도 금액마다 분류가 다르면)", fontSize = 13.sp)
                }
            }
        }
        if ((keepRule || agentOnly) && !income) {
            OutlinedTextField(
                word, { word = it.take(30) }, Modifier.fillMaxWidth(), singleLine = true,
                label = { Text("이 단어가 들어간 결제만 (선택)") },
                supportingText = { Text("가게 이름·메모(상품명)에 이 단어가 있으면 이 분류로 해요. 예: 중천. 가게·금액 기억보다 먼저예요.", fontSize = 11.sp) },
            )
        }

        if (!income) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("지출에 포함", fontSize = 15.sp)
                Text(
                    if (t.kind == Kind.TRANSFER) "송금은 끄면 합계·예산에서 빠져요" else "끄면 합계·예산에서 빠져요",
                    fontSize = 12.sp, color = C.sub,
                )
            }
            Switch(include, { include = it })
        }

        OffsetSection(t, onClose)

        AutoField(
            memo, { memo = it }, "메모", memoCands,
            onHide = { prefs.hiddenMemoSuggestions = hiddenMemos + it; hiddenMemos = prefs.hiddenMemoSuggestions },
        )

        Button(
            onClick = {
                val chosen = category
                repo.writer.execute {
                    val newAmount = amountText.toLongOrNull()?.takeIf { it > 0 }
                    val updated = if (!manual) t.copy(includeInSpending = include, memo = memo.trim())
                    else t.copy(
                        includeInSpending = include, memo = memo.trim(),
                        merchant = name.trim().ifEmpty { t.merchant }, originalMerchant = name.trim().ifEmpty { t.originalMerchant },
                        amount = newAmount ?: t.amount,
                        time = date.atTime(time ?: LocalTime.NOON), timeKnown = time != null,
                    )
                    repo.update(updated)
                    if (chosen != null && (chosen != t.category || keepRule || word.isNotBlank())) repo.setCategory(updated, chosen, (keepRule && !agentOnly) || word.isNotBlank(), byAmount, word.takeIf { it.isNotBlank() })
                    repo.changed()
                }
                onClose()
            },
            modifier = Modifier.fillMaxWidth().height(52.dp),
            shape = RoundedCornerShape(14.dp),
        ) { Text("저장", fontSize = 16.sp, fontWeight = FontWeight.Bold) }

        if (!income && t.kind != Kind.CANCEL) OutlinedButton(
            onClick = {
                repo.writer.execute {
                    val updated = t.copy(includeInSpending = include, memo = memo.trim())
                    repo.update(updated)
                    repo.setCategory(updated, Categories.HOLD, remember = false)
                    repo.changed()
                }
                onClose()
            },
            modifier = Modifier.fillMaxWidth().height(48.dp),
            shape = RoundedCornerShape(14.dp),
        ) { Text(if (t.category == Categories.HOLD) "보류 그대로 두기" else "보류 (나중에 분류)", fontSize = 15.sp) }

        Text(
            if (confirmDelete) "한 번 더 누르면 삭제돼요" else "이 기록 삭제",
            color = C.warn, fontSize = 14.sp,
            modifier = Modifier.clickable {
                if (confirmDelete) {
                    repo.writer.execute { repo.delete(t.id); repo.changed() }
                    onClose()
                } else confirmDelete = true
            }.padding(vertical = 8.dp),
        )
        Spacer(Modifier.height(16.dp))
    }
}

/** 분류 안 된 결제 모아 보기. held면 보류한 결제 */
@Composable
fun UncategorizedScreen(onBack: () -> Unit, held: Boolean = false, openTx: (Long) -> Unit) {
    val list = rememberData(held) { if (held) it.held() else it.uncategorized() } ?: return
    Column(Modifier.fillMaxSize()) {
        TopBar(if (held) "보류한 결제 ${list.size}건" else "분류 안 된 내역 ${list.size}건", onBack)
        if (list.isEmpty()) {
            Text(if (held) "보류한 결제가 없어요" else "모두 분류했어요", Modifier.padding(24.dp), color = C.sub)
        } else if (held) {
            Text(
                "메일 영수증과 짝지어지면 자동으로 분류돼요. 나머지는 하나씩 누르거나 분석 화면에서 한 번에 분류하세요.",
                Modifier.padding(start = 20.dp, end = 20.dp, bottom = 12.dp), fontSize = 13.sp, color = C.sub, lineHeight = 18.sp,
            )
        }
        LazyColumn(Modifier.padding(horizontal = 16.dp).clip(RoundedCornerShape(18.dp)).background(C.card)) {
            items(list, key = { it.id }) { t ->
                Column(Modifier.padding(horizontal = 16.dp)) {
                    TxRow(t) { openTx(t.id) }
                    Divider()
                }
            }
        }
    }
}

/**
 * 상계: 환불·입금을 원래 결제와 연결한다. 둘 다 그대로 두고, 통계에서 결제를 돌려받은 만큼 줄여 센다.
 * - 환불·입금 쪽: 연결된 결제를 보여 주고 풀 수 있다. 아직이면 연결할 결제를 고른다.
 * - 결제 쪽: 연결된 환불·입금 목록과 실제 지출. 더 연결할 수도 있다.
 */
@Composable
private fun OffsetSection(t: Tx, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val repo = Repository.get(ctx)
    val isBack = Offset.isBack(t) || t.offsetOf != null
    val isSpend = (t.kind == Kind.PAYMENT || t.kind == Kind.TRANSFER) && !t.cancelled && !MoneyFlow.isFlowCategory(t.category)
    if (!isBack && !isSpend) return

    fun save(vararg list: Tx) {
        repo.writer.execute {
            repo.transaction { list.forEach { repo.update(it) } }
            repo.changed()
        }
        onClose()
    }

    // 이미 연결된 것
    val linked = rememberData(t.id, t.offsetOf) { r ->
        if (t.offsetOf != null) listOfNotNull(r.byId(t.offsetOf!!)) else if (isSpend) r.linkedTo(t.id) else emptyList()
    } ?: return
    if (linked.isNotEmpty()) {
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.accentSoft).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (t.offsetOf != null) {
                val pay = linked.single()
                Text("상계됨: 이 돈만큼 아래 결제가 줄어든 금액으로 세져요", fontSize = 13.sp, color = C.accentDark, fontWeight = FontWeight.Medium)
                LinkedRow(pay, "연결 풀기") { save(Offset.unlink(t)) }
            } else {
                val back = linked.sumOf { it.amount }
                Text(
                    "돌려받은 돈 ${won(back)} 연결됨 · 실제 지출 ${won((t.amount - back).coerceAtLeast(0))}",
                    fontSize = 13.sp, color = C.accentDark, fontWeight = FontWeight.Medium,
                )
                linked.forEach { b -> LinkedRow(b, "풀기") { save(Offset.unlink(b)) } }
            }
        }
        if (t.offsetOf != null) return
    }

    var open by remember(t.id) { mutableStateOf(Offset.isOpen(t)) }
    if (!open) {
        Text(
            if (isSpend) "환불·더치페이 입금과 상계하기" else "원래 결제와 상계하기",
            color = C.accent, fontSize = 14.sp, modifier = Modifier.clickable { open = true }.padding(vertical = 4.dp),
        )
        return
    }
    val candidates = rememberData(t.id) { r -> Offset.candidates(t, r.between(t.time.minusDays(62), t.time.plusDays(62))).take(8) } ?: return
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.ground).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(if (isSpend) "어느 환불·입금과 상계할까요?" else "어느 결제와 상계할까요?", fontSize = 14.sp, fontWeight = FontWeight.Medium)
        Text("둘 다 지우지 않고 연결만 해요. 결제는 돌려받은 만큼 줄어든 금액으로 세고, 나중에 풀 수 있어요.", fontSize = 12.sp, color = C.sub, lineHeight = 17.sp)
        if (candidates.isEmpty()) Text("앞뒤 두 달 안에 상계할 내역이 없어요", fontSize = 13.sp, color = C.sub)
        candidates.forEach { c ->
            Row(
                Modifier.fillMaxWidth().clickable { save(Offset.link(t, c)) }.padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(c.merchant, fontSize = 14.sp, maxLines = 1)
                    Text(c.time.format(if (c.timeKnown) MD_HM else MD) + " · " + (c.category ?: "미분류"), fontSize = 12.sp, color = C.sub)
                }
                Text(sign(c) + won(c.amount), fontSize = 14.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

@Composable
private fun LinkedRow(o: Tx, action: String, onAction: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(o.merchant, fontSize = 14.sp, maxLines = 1)
            Text(o.time.format(if (o.timeKnown) MD_HM else MD) + " · " + sign(o) + won(o.amount), fontSize = 12.sp, color = C.sub)
        }
        Text(action, fontSize = 13.sp, color = C.warn, fontWeight = FontWeight.Medium, modifier = Modifier.clickable(onClick = onAction).padding(8.dp))
    }
}

/** 상계 안 한 입금·다음 달 환불 모아 보기 */
@Composable
fun RefundsScreen(onBack: () -> Unit, openTx: (Long) -> Unit) {
    val list = rememberData { it.openRefunds() } ?: return
    Column(Modifier.fillMaxSize()) {
        TopBar("상계 안 한 돈 ${list.size}건", onBack)
        Text(
            "돌려받은 돈·환불 중 아직 원래 결제와 연결하지 않은 것(최근 3달)이에요. 눌러서 연결하면 그 결제가 줄어든 금액으로 세져요. 연결하지 않은 환불은 들어온 달 지출에서 빠져요.",
            fontSize = 13.sp, color = C.sub, lineHeight = 18.sp, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        )
        LazyColumn(Modifier.padding(horizontal = 16.dp).clip(RoundedCornerShape(18.dp)).background(C.card)) {
            items(list, key = { it.id }) { t ->
                Column(Modifier.padding(horizontal = 16.dp)) {
                    TxRow(t) { openTx(t.id) }
                    Divider()
                }
            }
        }
    }
}
