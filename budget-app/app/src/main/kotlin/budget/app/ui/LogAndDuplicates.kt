package budget.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import budget.app.data.Prefs
import budget.app.data.Repository
import budget.core.DuplicateCheck
import java.time.format.DateTimeFormatter

/** 받은 결제 알림·문자 원문과 앱이 어떻게 처리했는지 (최근 180일) */
@Composable
fun NotiLogScreen(onBack: () -> Unit, openTx: (Long) -> Unit) {
    val ctx = LocalContext.current
    val repo = Repository.get(ctx)
    val list = rememberData { it.logs() } ?: return
    val fmt = DateTimeFormatter.ofPattern("M/d HH:mm")
    Column(Modifier.fillMaxSize()) {
        TopBar("받은 결제 알림 ${list.size}건", onBack)
        Text(
            "카드·네이버페이·은행 알림과 문자를 원문 그대로 모아 둬요. 눌러서 기록된 내역을 볼 수 있어요. 최근 180일만 남고, 이 목록은 폰 안에만 있어요.",
            fontSize = 13.sp, color = C.sub, lineHeight = 18.sp, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        )
        if (list.isNotEmpty()) {
            Text(
                "기록 모두 지우기", color = C.warn, fontSize = 14.sp,
                modifier = Modifier.clickable { repo.writer.execute { repo.deleteLogs(); repo.changed() } }
                    .padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }
        LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(list, key = { it.id }) { l ->
                val failed = l.result.startsWith("읽지 못함")
                Column(
                    Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.card)
                        .clickable(enabled = l.txId != null) { l.txId?.let(openTx) }.padding(14.dp),
                ) {
                    Text("${l.origin} · ${l.time.format(fmt)}", fontSize = 12.sp, color = C.sub)
                    Text(l.result, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = if (failed) C.warn else C.accentDark)
                    Text(l.text, fontSize = 14.sp, lineHeight = 20.sp)
                }
            }
        }
    }
}

/** 같은 결제가 두 번 잡혔을 수 있는 쌍. 하나를 지우거나 '중복 아님'으로 표시한다. */
@Composable
fun DuplicatesScreen(onBack: () -> Unit, openTx: (Long) -> Unit) {
    val ctx = LocalContext.current
    val repo = Repository.get(ctx)
    val prefs = remember { Prefs(ctx) }
    var dismissed by remember { mutableStateOf(prefs.dismissedDuplicates) }
    val list = rememberData(dismissed) { DuplicateCheck.suspects(it.all(), dismissed) } ?: return
    Column(Modifier.fillMaxSize()) {
        TopBar("중복 의심 ${list.size}건", onBack)
        Text(
            "금액이 같고 시각이 가까운데 따로 기록된 결제예요. 같은 결제면 하나를 지우고, 따로 낸 거면 '중복 아님'을 눌러 주세요.",
            fontSize = 13.sp, color = C.sub, lineHeight = 18.sp, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        )
        if (list.isEmpty()) Panel { Text("중복 의심 결제가 없어요.", color = C.sub, fontSize = 14.sp) }
        LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(list, key = { it.key }) { s ->
                Column(Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(C.card).padding(horizontal = 16.dp)) {
                    listOf(s.a, s.b).forEach { t ->
                        TxRow(t) { openTx(t.id) }
                        Row(Modifier.fillMaxWidth().padding(bottom = 6.dp)) {
                            Text("${t.source.label}", fontSize = 12.sp, color = C.sub, modifier = Modifier.weight(1f))
                            Text(
                                "이것 지우기", fontSize = 13.sp, color = C.warn,
                                modifier = Modifier.clickable { repo.writer.execute { repo.delete(t.id); repo.changed() } }.padding(4.dp),
                            )
                        }
                        Divider()
                    }
                    Text(
                        "중복 아님 (둘 다 남기기)", fontSize = 14.sp, color = C.accent, fontWeight = FontWeight.Medium,
                        modifier = Modifier.clickable {
                            dismissed = dismissed + s.key
                            prefs.dismissedDuplicates = dismissed
                        }.padding(vertical = 12.dp),
                    )
                }
            }
        }
    }
}
