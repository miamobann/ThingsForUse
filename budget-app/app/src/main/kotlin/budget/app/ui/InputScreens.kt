package budget.app.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import budget.app.data.Prefs
import budget.app.data.Repository
import budget.app.ingest.Ingest
import budget.core.AppCsv
import budget.core.Autocomplete
import budget.core.SameDay
import budget.core.Tx
import budget.core.HyundaiCardFileParser
import budget.core.Parsed
import budget.core.ImportPreview
import budget.core.Kind
import budget.core.MoneyFlow
import budget.core.Source
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.nio.charset.Charset
import java.time.LocalDate
import java.time.LocalTime

/** 직접 입력: 현금 지출, 저축(적금 등 문자가 안 오는 것), 수입. 지난 날짜·시각, 가게명·메모 따로, 자동 완성. */
@Composable
fun AddCashScreen(onDone: () -> Unit) {
    val ctx = LocalContext.current
    val prefs = Prefs(ctx)
    val repo = Repository.get(ctx)
    val scope = rememberCoroutineScope()
    var amount by remember { mutableStateOf("") }
    var where by remember { mutableStateOf("") }
    var memo by remember { mutableStateOf("") }
    var date by remember { mutableStateOf(LocalDate.now()) }
    var time by remember { mutableStateOf<LocalTime?>(LocalTime.now().withSecond(0).withNano(0)) }
    var category by remember { mutableStateOf(prefs.categories.first()) }
    var method by remember { mutableStateOf("현금") }
    var type by remember { mutableStateOf("지출") }
    var sameDay by remember { mutableStateOf<List<Tx>?>(null) }
    var savedCount by remember { mutableStateOf(0) }
    var hiddenMerchants by remember { mutableStateOf(prefs.hiddenMerchantSuggestions) }
    var hiddenMemos by remember { mutableStateOf(prefs.hiddenMemoSuggestions) }
    val value = amount.filter { it.isDigit() }.toLongOrNull() ?: 0L
    val all = rememberData { it.all() } ?: emptyList()
    val merchantCands = remember(all, hiddenMerchants) { Autocomplete.merchants(all, hiddenMerchants) }
    val memoCands = remember(all, hiddenMemos) { Autocomplete.memos(all, hiddenMemos) }
    val kind = when (type) {
        MoneyFlow.SAVING -> Kind.TRANSFER
        MoneyFlow.EARNED -> Kind.INCOME
        else -> Kind.PAYMENT
    }

    fun save(keepGoing: Boolean) {
        val (k, cat) = when (type) {
            MoneyFlow.SAVING -> Kind.TRANSFER to MoneyFlow.SAVING
            MoneyFlow.EARNED -> Kind.INCOME to MoneyFlow.EARNED
            else -> Kind.PAYMENT to category
        }
        val name = where.trim().ifEmpty { if (type == "지출") method.substringBefore(" (") else type }
        val at = date.atTime(time ?: LocalTime.NOON)
        Ingest.addManual(
            ctx,
            Parsed(Source.MANUAL, k, value, name, at, timeKnown = time != null, raw = if (type == "지출") method else "", detail = memo.trim()),
            cat,
        )
        sameDay = null
        if (keepGoing) {
            savedCount++
            amount = ""
            where = ""
            memo = ""
        } else onDone()
    }

    /** 같은 날 같은 금액 기록이 있으면 먼저 보여주고, 한 번 더 누르면 저장 */
    fun trySave(keepGoing: Boolean) {
        if (sameDay != null) return save(keepGoing)
        scope.launch {
            val found = withContext(Dispatchers.IO) {
                SameDay.find(repo.between(date.atStartOfDay(), date.plusDays(1).atStartOfDay()), date, value, kind)
            }
            if (found.isEmpty()) save(keepGoing) else sameDay = found
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        TopBar("직접 입력", onDone)
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            if (savedCount > 0) Text("${savedCount}건 저장했어요. 이어서 입력하세요.", fontSize = 13.sp, color = C.accentDark, fontWeight = FontWeight.Medium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("지출", MoneyFlow.SAVING, MoneyFlow.EARNED).forEach { k -> Chip(k, type == k, Modifier.weight(1f)) { type = k; sameDay = null } }
            }
            if (type != "지출") Text(
                if (type == MoneyFlow.SAVING) "적금처럼 문자가 안 오는 저축을 적어요. 지출·예산에서 빠지고, 이번 달 저축에 더해져요."
                else "번 돈(월급·부수입 등)을 적어요. 기준일(${prefs.cutoffDay}일) 이후 날짜면 다음 달 수입으로 세요.",
                fontSize = 13.sp, color = C.sub, lineHeight = 18.sp,
            )
            OutlinedTextField(
                if (value > 0) "%,d".format(value) else "", { amount = it; sameDay = null },
                Modifier.fillMaxWidth(), label = { Text("금액 (원)") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                textStyle = androidx.compose.ui.text.TextStyle(fontSize = 26.sp, fontWeight = FontWeight.Bold),
            )
            AutoField(
                where, { where = it },
                when (type) {
                    MoneyFlow.SAVING -> "어디로 (예: 적금 은행)"
                    MoneyFlow.EARNED -> "어디서 (예: 회사)"
                    else -> "가게 이름"
                },
                merchantCands,
                onHide = { prefs.hiddenMerchantSuggestions = hiddenMerchants + it; hiddenMerchants = prefs.hiddenMerchantSuggestions },
                onPick = { name ->
                    if (type == "지출") scope.launch {
                        val remembered = withContext(Dispatchers.IO) { repo.ruleFor(name, Kind.PAYMENT, value.takeIf { it > 0 }, name.lowercase()) }
                        if (remembered != null && remembered in prefs.categories) category = remembered
                    }
                },
            )
            AutoField(
                memo, { memo = it }, "메모 (선택)", memoCands,
                onHide = { prefs.hiddenMemoSuggestions = hiddenMemos + it; hiddenMemos = prefs.hiddenMemoSuggestions },
            )
            DateTimeInput(
                date, time,
                onDate = { d ->
                    date = d
                    time = if (d == LocalDate.now()) LocalTime.now().withSecond(0).withNano(0) else null
                    sameDay = null
                },
                onTime = { time = it },
            )
            if (type == "지출") Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("카테고리", fontSize = 13.sp, color = C.sub)
                prefs.categories.chunked(4).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { c -> Chip(c, category == c, Modifier.weight(1f)) { category = c } }
                        repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
            if (type == "지출") Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("결제 수단", fontSize = 13.sp, color = C.sub)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("현금", "기타 (상품권 등)").forEach { m -> Chip(m, method == m, Modifier.weight(1f)) { method = m } }
                }
            }
            sameDay?.let { list ->
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.card).padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text("같은 날 같은 금액 기록이 이미 있어요", fontSize = 14.sp, fontWeight = FontWeight.Bold, color = C.warn)
                    list.take(3).forEach { t ->
                        Text(
                            "${t.merchant} · ${if (t.timeKnown) t.time.format(MD_HM) else t.time.format(MD)} · ${t.source.label}",
                            fontSize = 13.sp, color = C.sub,
                        )
                    }
                    Text("같은 결제면 저장하지 마세요. 다른 결제면 아래 버튼을 한 번 더 누르면 저장돼요.", fontSize = 12.sp, color = C.sub, lineHeight = 17.sp)
                }
            }
            Button(
                enabled = value > 0,
                onClick = { trySave(false) },
                modifier = Modifier.fillMaxWidth().height(54.dp),
                shape = RoundedCornerShape(14.dp),
            ) { Text(if (sameDay != null) "그래도 저장" else "저장", fontSize = 16.sp, fontWeight = FontWeight.Bold) }
            OutlinedButton(
                enabled = value > 0,
                onClick = { trySave(true) },
                modifier = Modifier.fillMaxWidth().height(48.dp),
                shape = RoundedCornerShape(14.dp),
            ) { Text(if (sameDay != null) "그래도 저장하고 계속 입력" else "저장하고 계속 입력", fontSize = 15.sp) }
        }
    }
}

/** 현대카드 파일 올리기: 미리보기 → 추가 */
@Composable
fun ImportScreen(onDone: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var fileName by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<Loaded?>(null) }
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
                    val card = HyundaiCardFileParser.parse(text)
                    val loaded = if (card != null) {
                        Loaded("${card.type.label}로 읽었어요", card.rows, null)
                    } else {
                        val csv = runCatching { AppCsv.parse(text) }.getOrNull()?.takeIf { it.rows.isNotEmpty() }
                            ?: error("현대카드 이용내역이나 가계부 CSV 파일이 아니에요")
                        Loaded(
                            "가계부 CSV로 읽었어요" + if (csv.skipped > 0) " (읽지 못한 줄 ${csv.skipped}개)" else "",
                            csv.rows.map { it.parsed.copy(cancelled = false) }, csv.rows,
                        )
                    }
                    val existing = Repository.get(ctx).let { repo ->
                        if (loaded.rows.isEmpty()) emptyList()
                        else repo.between(loaded.rows.minOf { it.time }.minusDays(3), loaded.rows.maxOf { it.time }.plusDays(3))
                    }
                    loaded to ImportPreview.simulate(loaded.rows, existing, independentRows = loaded.csv != null)
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
            Text("분석 프로그램에서 내보낸 가계부 CSV도 넣을 수 있어요. 분류·메모를 그대로 가져와요.", fontSize = 13.sp, color = C.sub, lineHeight = 18.sp)
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
                Text("${r.label} · ${r.rows.size}건", fontSize = 13.sp, color = C.accentDark)
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
                            val n = withContext(Dispatchers.IO) {
                                r.csv?.let { Ingest.importCsv(ctx, it) } ?: Ingest.importRows(ctx, r.rows)
                            }
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

/** 읽은 파일. csv가 있으면 가계부 CSV (분류·메모까지 넣는다) */
private class Loaded(val label: String, val rows: List<Parsed>, val csv: List<AppCsv.Row>?)

@Composable
private fun Stat(label: String, n: Int, modifier: Modifier) {
    Column(modifier, horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally) {
        Text("$n", fontSize = 22.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
        Text(label, fontSize = 12.sp, color = C.sub)
    }
}
