package budget.app.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import budget.app.data.Prefs
import budget.app.data.Repository
import budget.app.ingest.Ingest
import budget.core.HyundaiCardFileParser
import budget.core.ImportPreview
import budget.core.Kind
import budget.core.Parsed
import budget.core.Source
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.nio.charset.Charset
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/** 현금 지출 직접 입력 */
@Composable
fun AddCashScreen(onDone: () -> Unit) {
    val ctx = LocalContext.current
    val prefs = Prefs(ctx)
    var amount by remember { mutableStateOf("") }
    var where by remember { mutableStateOf("") }
    var date by remember { mutableStateOf(LocalDate.now()) }
    var category by remember { mutableStateOf(prefs.categories.first()) }
    var method by remember { mutableStateOf("현금") }
    val value = amount.filter { it.isDigit() }.toLongOrNull() ?: 0L

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        TopBar("현금 지출 입력", onDone)
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            OutlinedTextField(
                if (value > 0) "%,d".format(value) else "", { amount = it },
                Modifier.fillMaxWidth(), label = { Text("금액 (원)") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                textStyle = androidx.compose.ui.text.TextStyle(fontSize = 26.sp, fontWeight = FontWeight.Bold),
            )
            OutlinedTextField(where, { where = it }, Modifier.fillMaxWidth(), label = { Text("어디서 / 메모") }, singleLine = true)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("날짜", fontSize = 13.sp, color = C.sub)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("오늘" to LocalDate.now(), "어제" to LocalDate.now().minusDays(1), "그저께" to LocalDate.now().minusDays(2))
                        .forEach { (label, d) -> Chip(label, date == d, Modifier.weight(1f)) { date = d } }
                }
                Text(date.format(DateTimeFormatter.ofPattern("yyyy년 M월 d일")), fontSize = 13.sp, color = C.sub)
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("카테고리", fontSize = 13.sp, color = C.sub)
                prefs.categories.chunked(4).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { c -> Chip(c, category == c, Modifier.weight(1f)) { category = c } }
                        repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("결제 수단", fontSize = 13.sp, color = C.sub)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("현금", "기타 (상품권 등)").forEach { m -> Chip(m, method == m, Modifier.weight(1f)) { method = m } }
                }
            }
            Button(
                enabled = value > 0,
                onClick = {
                    val time = if (date == LocalDate.now()) LocalDateTime.now() else date.atTime(LocalTime.NOON)
                    val name = where.trim().ifEmpty { "현금" }
                    Ingest.addManual(
                        ctx,
                        Parsed(Source.MANUAL, Kind.PAYMENT, value, name, time, timeKnown = date == LocalDate.now(), raw = method),
                        category,
                    )
                    onDone()
                },
                modifier = Modifier.fillMaxWidth().height(54.dp),
                shape = RoundedCornerShape(14.dp),
            ) { Text("저장", fontSize = 16.sp, fontWeight = FontWeight.Bold) }
        }
    }
}

/** 현대카드 파일 올리기: 미리보기 → 추가 */
@Composable
fun ImportScreen(onDone: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var fileName by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<HyundaiCardFileParser.Result?>(null) }
    var preview by remember { mutableStateOf<ImportPreview.Summary?>(null) }
    var errorMsg by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var done by remember { mutableStateOf<Int?>(null) }

    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        busy = true
        errorMsg = null
        done = null
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    val bytes = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                    var text = String(bytes, Charsets.UTF_8)
                    if (text.contains('�')) text = String(bytes, Charset.forName("EUC-KR"))
                    val parsed = HyundaiCardFileParser.parse(text) ?: error("현대카드 이용내역 파일 형식이 아니에요")
                    val existing = Repository.get(ctx).let { repo ->
                        if (parsed.rows.isEmpty()) emptyList()
                        else repo.between(parsed.rows.minOf { it.time }.minusDays(3), parsed.rows.maxOf { it.time }.plusDays(3))
                    }
                    parsed to ImportPreview.simulate(parsed.rows, existing)
                }
            }
            busy = false
            fileName = uri.lastPathSegment?.substringAfterLast('/')
            r.onSuccess { (parsed, sum) -> result = parsed; preview = sum }
                .onFailure { errorMsg = it.message; result = null; preview = null }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        TopBar("파일 올리기", onDone)
        Panel {
            Text("현대카드 홈페이지 → 이용내역에서 받은 파일(.xls)을 골라주세요.", fontSize = 14.sp, lineHeight = 20.sp)
            Text("월 이용대금명세서, 실시간 이용내역 둘 다 돼요. 알림·문자로 이미 들어온 결제는 건너뛰어요.", fontSize = 13.sp, color = C.sub, lineHeight = 18.sp)
            Spacer(Modifier.height(4.dp))
            Button(onClick = { LockGuard.skipNext = true; pick.launch(arrayOf("*/*")) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                Text(if (busy) "읽는 중…" else "파일 고르기")
            }
            Text("농협 거래내역 파일은 샘플을 받으면 추가할게요.", fontSize = 12.sp, color = C.sub)
        }
        errorMsg?.let { Spacer(Modifier.height(12.dp)); Panel { Text(it, color = C.warn, fontSize = 14.sp) } }
        val r = result
        val p = preview
        if (r != null && p != null && done == null) {
            Spacer(Modifier.height(12.dp))
            Panel {
                Text(fileName ?: "선택한 파일", fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Text("${r.type.label}로 읽었어요 · ${r.rows.size}건", fontSize = 13.sp, color = C.accentDark)
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Stat("새로 추가", p.added.size, Modifier.weight(1f))
                    Stat("이미 기록됨", p.duplicates + p.attached, Modifier.weight(1f))
                    Stat("취소 반영", p.cancels, Modifier.weight(1f))
                }
                if (p.ignored > 0) Text("취소된 가승인 ${p.ignored}건은 기록하지 않아요", fontSize = 12.sp, color = C.sub)
                p.added.take(30).forEach { a ->
                    Divider()
                    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(budget.core.Merchants.displayName(a.merchant), fontSize = 14.sp, maxLines = 1)
                            Text(a.time.format(if (a.timeKnown) MD_HM else MD), fontSize = 12.sp, color = C.sub)
                        }
                        Text((if (a.kind == Kind.CANCEL) "-" else "") + won(a.amount), fontSize = 14.sp, fontWeight = FontWeight.Medium)
                    }
                }
                if (p.added.size > 30) Text("…외 ${p.added.size - 30}건", fontSize = 12.sp, color = C.sub)
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = {
                        busy = true
                        scope.launch {
                            val n = withContext(Dispatchers.IO) { Ingest.importRows(ctx, r.rows) }
                            busy = false
                            done = n
                        }
                    },
                    enabled = !busy && (p.added.isNotEmpty() || p.cancels > 0 || p.duplicates > 0),
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                    shape = RoundedCornerShape(14.dp),
                ) { Text(if (p.added.isEmpty()) "취소·승인번호만 반영하기" else "${p.added.size}건 추가하기", fontWeight = FontWeight.Bold) }
            }
        }
        done?.let {
            Spacer(Modifier.height(12.dp))
            Panel {
                Text("${it}건을 추가했어요.", fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Text("분류가 필요한 결제는 홈의 '분류 안 된 결제'에서 모아서 고를 수 있어요.", fontSize = 13.sp, color = C.sub)
                Button(onClick = onDone, modifier = Modifier.fillMaxWidth()) { Text("홈으로") }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Stat(label: String, n: Int, modifier: Modifier) {
    Column(modifier, horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally) {
        Text("$n", fontSize = 22.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
        Text(label, fontSize = 12.sp, color = C.sub)
    }
}
