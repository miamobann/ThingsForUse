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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import budget.app.data.Prefs
import budget.app.data.Repository
import budget.core.Installment
import budget.core.Kind
import budget.core.Offset
import budget.core.Merchants
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
    var include by remember(t.id) { mutableStateOf(t.includeInSpending) }
    var memo by remember(t.id) { mutableStateOf(t.memo) }
    var newCategory by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }

    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).navigationBarsPadding(),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (t.category == null) Text("처음 보는 가게예요", fontSize = 13.sp, color = C.accent, fontWeight = FontWeight.Medium)
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

        OffsetSection(t, onClose)

        Text("카테고리", fontSize = 15.sp, fontWeight = FontWeight.Medium)
        prefs.categories.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { c -> Chip(c, category == c, Modifier.weight(1f)) { category = c } }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
        if (newCategory == null) {
            Text("+ 새 카테고리 만들기", color = C.accent, fontSize = 14.sp, modifier = Modifier.clickable { newCategory = "" }.padding(vertical = 4.dp))
        } else {
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
                Text("다음부터 이 가게는 자동으로 같은 카테고리로 분류", fontSize = 14.sp)
            }
        }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("지출에 포함", fontSize = 15.sp)
                Text(
                    if (t.kind == Kind.TRANSFER) "송금은 끄면 합계·예산에서 빠져요" else "끄면 합계·예산에서 빠져요",
                    fontSize = 12.sp, color = C.sub,
                )
            }
            Switch(include, { include = it })
        }

        OutlinedTextField(memo, { memo = it }, Modifier.fillMaxWidth(), label = { Text("메모") }, singleLine = true)

        Button(
            onClick = {
                val chosen = category
                repo.writer.execute {
                    val updated = t.copy(includeInSpending = include, memo = memo)
                    repo.update(updated)
                    if (chosen != null && (chosen != t.category || keepRule)) repo.setCategory(updated, chosen, keepRule && !agentOnly)
                    repo.changed()
                }
                onClose()
            },
            modifier = Modifier.fillMaxWidth().height(52.dp),
            shape = RoundedCornerShape(14.dp),
        ) { Text("저장", fontSize = 16.sp, fontWeight = FontWeight.Bold) }

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

/** 분류 안 된 결제 모아 보기 */
@Composable
fun UncategorizedScreen(onBack: () -> Unit, openTx: (Long) -> Unit) {
    val list = rememberData { it.uncategorized() } ?: return
    Column(Modifier.fillMaxSize()) {
        TopBar("분류 안 된 결제 ${list.size}건", onBack)
        if (list.isEmpty()) {
            Text("모두 분류했어요", Modifier.padding(24.dp), color = C.sub)
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

/** 상계: 환불·입금을 원래 결제와 맞붙여 지우거나 금액을 줄인다 */
@Composable
private fun OffsetSection(t: Tx, onClose: () -> Unit) {
    if (!(t.kind == Kind.INCOME || t.kind == Kind.CANCEL || ((t.kind == Kind.PAYMENT || t.kind == Kind.TRANSFER) && !t.cancelled))) return
    val ctx = LocalContext.current
    val repo = Repository.get(ctx)
    var open by remember(t.id) { mutableStateOf(t.kind == Kind.INCOME || t.kind == Kind.CANCEL) }
    if (!open) {
        Text("환불·더치페이 입금과 상계하기", color = C.accent, fontSize = 14.sp, modifier = Modifier.clickable { open = true }.padding(vertical = 4.dp))
        return
    }
    val candidates = rememberData(t.id) { r -> Offset.candidates(t, r.between(t.time.minusDays(62), t.time.plusDays(62))).take(8) } ?: return
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.ground).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            if (t.kind == Kind.INCOME || t.kind == Kind.CANCEL) "어느 결제와 상계할까요?" else "어느 환불·입금과 상계할까요?",
            fontSize = 14.sp, fontWeight = FontWeight.Medium,
        )
        Text("금액이 같으면 둘 다 지우고, 돌려받은 돈이 적으면 결제 금액을 그만큼 줄여요.", fontSize = 12.sp, color = C.sub, lineHeight = 17.sp)
        if (candidates.isEmpty()) Text("앞뒤 두 달 안에 상계할 내역이 없어요", fontSize = 13.sp, color = C.sub)
        candidates.forEach { c ->
            Row(
                Modifier.fillMaxWidth().clickable {
                    val r = Offset.apply(t, c)
                    repo.writer.execute {
                        repo.transaction {
                            r.update.forEach { repo.update(it) }
                            r.delete.forEach { repo.delete(it) }
                        }
                        repo.changed()
                    }
                    onClose()
                }.padding(vertical = 8.dp),
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

/** 상계 안 한 입금·다음 달 환불 모아 보기 */
@Composable
fun RefundsScreen(onBack: () -> Unit, openTx: (Long) -> Unit) {
    val list = rememberData { it.openRefunds() } ?: return
    Column(Modifier.fillMaxSize()) {
        TopBar("입금·환불 ${list.size}건", onBack)
        Text(
            "눌러서 원래 결제와 상계하세요. 더치페이 입금이면 그 결제 금액이 줄어요. 상계할 필요 없는 입금은 그대로 두면 돼요(지출에 안 들어가요).",
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
