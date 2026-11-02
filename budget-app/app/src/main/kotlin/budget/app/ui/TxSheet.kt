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
import budget.core.Kind
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
                    (if (t.kind == Kind.CANCEL) "-" else "") + won(t.amount),
                    if (t.timeKnown) t.time.format(MD_HM) else t.time.format(MD),
                    t.source.label,
                    if (t.cancelled) "취소됨" else null,
                ).joinToString(" · "),
                fontSize = 15.sp, color = C.sub,
            )
            if (t.originalMerchant != t.merchant) Text("카드 표시: ${t.originalMerchant}", fontSize = 12.sp, color = C.sub)
        }

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
