package budget.app.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import budget.app.data.AutoSaveLinks
import budget.app.data.SheetSync
import budget.app.data.SyncSettings
import budget.app.data.Export
import budget.app.data.Prefs
import budget.app.data.Repository
import budget.app.ingest.Ingest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.format.DateTimeFormatter

@Composable
fun SettingsScreen(go: (Screen) -> Unit) {
    val ctx = LocalContext.current
    val prefs = remember { Prefs(ctx) }
    val links = remember { AutoSaveLinks(ctx) }
    val repo = Repository.get(ctx)
    val scope = rememberCoroutineScope()

    // 다른 설정 화면에 다녀오면 권한 상태를 다시 읽는다
    var refresh by remember { mutableIntStateOf(0) }
    @Suppress("DEPRECATION")
    val owner = androidx.compose.ui.platform.LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) refresh++ }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }

    val listenerOn = remember(refresh) { NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName) }
    val notiOn = remember(refresh) {
        Build.VERSION.SDK_INT < 33 || ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED
    }
    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { refresh++ }

    var budgetText by remember { mutableStateOf(prefs.monthlyBudget.toString()) }
    var includeTransfers by remember { mutableStateOf(prefs.includeTransfers) }
    var lock by remember { mutableStateOf(prefs.lockEnabled) }
    var csvUri by remember { mutableStateOf(links.csv) }
    var backupUri by remember { mutableStateOf(links.backup) }
    var saveResult by remember { mutableStateOf(links.lastResult) }
    var message by remember { mutableStateOf<String?>(null) }

    fun keep(uri: Uri) {
        ctx.contentResolver.takePersistableUriPermission(
            uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
    }

    fun saveNow() {
        scope.launch {
            val err = withContext(Dispatchers.IO) { Export.saveNow(ctx) }
            saveResult = links.lastResult
            message = err
        }
    }

    val linkCsv = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { uri ->
        if (uri != null) { keep(uri); links.csv = uri; csvUri = uri; saveNow() }
    }
    val linkBackup = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        if (uri != null) { keep(uri); links.backup = uri; backupUri = uri; saveNow() }
    }
    var restoreUri by remember { mutableStateOf<Uri?>(null) }
    val pickRestore = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> restoreUri = uri }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Text("설정", fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(20.dp))

        SectionTitle("자동 기록 권한")
        Panel {
            PermissionRow("알림 읽기 (카드·네이버페이·문자 앱)", listenerOn) {
                LockGuard.skipNext = true
                ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }
            Text(
                "농협·카드 문자는 문자 앱 알림으로 읽어요. 문자 앱 알림을 끄면 기록되지 않아요.",
                fontSize = 12.sp, color = C.sub, lineHeight = 17.sp,
            )
            if (Build.VERSION.SDK_INT >= 33) {
                Divider()
                PermissionRow("알림 보내기 (예산·분류 알림)", notiOn) {
                    LockGuard.skipNext = true
                    askPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            }
            if (Build.VERSION.SDK_INT >= 33 && !listenerOn) {
                Text(
                    "켜기가 막혀 있으면: 휴대폰 설정 → 애플리케이션 → 가계부 → 오른쪽 위 ⋮ → '제한된 설정 허용'을 먼저 눌러주세요. 직접 설치한 앱이라 한 번 필요해요.",
                    fontSize = 12.sp, color = C.sub, lineHeight = 17.sp,
                    modifier = Modifier.clickable {
                        LockGuard.skipNext = true
                        ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")))
                    },
                )
            }
        }

        SectionTitle("예산")
        Panel {
            OutlinedTextField(
                budgetText,
                { v ->
                    budgetText = v.filter { it.isDigit() }.take(10)
                    prefs.monthlyBudget = budgetText.toLongOrNull() ?: 0
                    repo.changed()
                },
                Modifier.fillMaxWidth(), label = { Text("월 예산 (원)") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
            Text("예산의 80%, 100%를 넘으면 알려드려요. 0으로 두면 예산을 쓰지 않아요.", fontSize = 12.sp, color = C.sub)
            Divider()
            SwitchRow("송금을 지출에 포함", "끄면 송금 전체가 합계·예산에서 빠져요. 한 건씩은 내역을 눌러서 바꿀 수 있어요.", includeTransfers) {
                includeTransfers = it
                prefs.includeTransfers = it
                repo.changed()
            }
        }

        SectionTitle("잠금")
        Panel {
            SwitchRow("앱 잠금", "열 때마다 지문이나 휴대폰 비밀번호로 잠금을 풀어요.", lock) {
                lock = it
                prefs.lockEnabled = it
            }
        }

        SectionTitle("구글 시트 연동")
        SheetSyncPanel()

        SectionTitle("구글 드라이브 저장")
        Panel {
            Text(
                "파일 위치를 한 번 고르면 내역이 바뀔 때마다 그 파일을 덮어써요. 저장 위치 화면에서 왼쪽 메뉴의 '드라이브'를 고르면 구글 드라이브에 저장돼요.",
                fontSize = 13.sp, color = C.sub, lineHeight = 18.sp,
            )
            LinkRow("백업 파일", "가계부_백업.json", backupUri) { LockGuard.skipNext = true; linkBackup.launch("가계부_백업.json") }
            Divider()
            LinkRow("분석용 내역 (CSV)", "가계부_내역_전체.csv", csvUri) { LockGuard.skipNext = true; linkCsv.launch("가계부_내역_전체.csv") }
            if (csvUri != null || backupUri != null) {
                Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(saveResult ?: "아직 저장 안 함", fontSize = 12.sp, color = C.sub, modifier = Modifier.weight(1f))
                    SmallButton("지금 저장") { saveNow() }
                }
            }
            message?.let { Text(it, fontSize = 12.sp, color = C.warn) }
            Divider()
            Text(
                "백업 파일에서 복원 (지금 내역은 지워져요)", fontSize = 14.sp, color = C.warn,
                modifier = Modifier.clickable { LockGuard.skipNext = true; pickRestore.launch(arrayOf("application/json", "*/*")) }.padding(vertical = 8.dp),
            )
            Text(
                "휴대폰의 구글 백업(설정 → Google → 백업)이 켜져 있으면 앱 데이터도 자동으로 백업돼서 새 폰에 설치할 때 돌아와요.",
                fontSize = 12.sp, color = C.sub, lineHeight = 17.sp,
            )
        }

        SectionTitle("기타")
        Panel {
            Row(Modifier.fillMaxWidth().clickable { go(Screen.Unparsed) }.padding(vertical = 8.dp)) {
                Text("읽지 못한 알림·문자", fontSize = 15.sp, modifier = Modifier.weight(1f))
                Text("보기 ›", fontSize = 14.sp, color = C.accent)
            }
        }
        Spacer(Modifier.height(32.dp))
    }

    restoreUri?.let { uri ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { restoreUri = null },
            title = { Text("백업에서 복원할까요?") },
            text = { Text("지금 앱에 있는 내역과 분류 규칙이 모두 백업 파일 내용으로 바뀌어요.") },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    restoreUri = null
                    scope.launch {
                        message = withContext(Dispatchers.IO) {
                            runCatching {
                                val json = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes().toString(Charsets.UTF_8) }
                                "${Export.restore(repo, prefs, json)}건을 복원했어요"
                            }.getOrElse { "복원 실패: ${it.message}" }
                        }
                        budgetText = prefs.monthlyBudget.toString()
                        includeTransfers = prefs.includeTransfers
                    }
                }) { Text("복원") }
            },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { restoreUri = null }) { Text("취소") } },
        )
    }
}

@Composable
private fun PermissionRow(label: String, on: Boolean, onFix: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, fontSize = 15.sp, modifier = Modifier.weight(1f))
        if (on) Text("켜짐", fontSize = 14.sp, color = C.accentDark, fontWeight = FontWeight.Bold)
        else SmallButton("켜기", onFix)
    }
}

@Composable
private fun SwitchRow(label: String, help: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, fontSize = 15.sp)
            Text(help, fontSize = 12.sp, color = C.sub, lineHeight = 17.sp)
        }
        Spacer(Modifier.padding(6.dp))
        Switch(value, onChange)
    }
}

@Composable
private fun LinkRow(label: String, suggested: String, uri: Uri?, onPick: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, fontSize = 15.sp)
            Text(if (uri == null) "연결 안 됨 ($suggested)" else "연결됨", fontSize = 12.sp, color = if (uri == null) C.sub else C.accentDark)
        }
        SmallButton(if (uri == null) "위치 고르기" else "다시 고르기", onPick)
    }
}

/** 알림·문자 중 형식을 못 알아본 것들. 이걸 보고 읽는 규칙을 고친다. */
@Composable
fun UnparsedScreen(onBack: () -> Unit) {
    val ctx = LocalContext.current
    val repo = Repository.get(ctx)
    val list = rememberData { it.unparsed() } ?: return
    val fmt = DateTimeFormatter.ofPattern("M/d HH:mm")
    Column(Modifier.fillMaxSize()) {
        TopBar("읽지 못한 알림·문자 ${list.size}건", onBack)
        Text(
            "결제 알림인데 여기 쌓이면 문구를 알려주세요. 읽는 규칙을 고칠게요. 이 목록은 폰 안에만 있어요.",
            fontSize = 13.sp, color = C.sub, lineHeight = 18.sp, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        )
        if (list.isNotEmpty()) {
            Text(
                "모두 지우기", color = C.warn, fontSize = 14.sp,
                modifier = Modifier.clickable { repo.writer.execute { repo.deleteUnparsed(null); repo.changed() } }.padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }
        LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(list, key = { it.id }) { u ->
                Column(
                    Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.card).padding(14.dp),
                ) {
                    Text("${u.origin} · ${u.time.format(fmt)}", fontSize = 12.sp, color = C.sub)
                    Text(u.text, fontSize = 14.sp, lineHeight = 20.sp)
                }
            }
        }
    }
}

@Composable
private fun SheetSyncPanel() {
    val ctx = LocalContext.current
    val sync = remember { SyncSettings(ctx) }
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf(sync.url ?: "") }
    var key by remember { mutableStateOf(sync.key) }
    var result by remember { mutableStateOf(sync.lastResult) }
    var busy by remember { mutableStateOf(false) }
    Panel {
        Text(
            "구글 시트의 앱스 스크립트 웹 앱 주소와 연결 비밀번호를 넣으면, 내역이 바뀔 때마다 시트 '내역'에 올리고 " +
                "분석 화면에서 고친 분류를 받아와요. 인터넷이 안 될 때 바뀐 건 다음에 연결되면 보내요.",
            fontSize = 13.sp, color = C.sub, lineHeight = 18.sp,
        )
        OutlinedTextField(
            url, { url = it.trim() }, Modifier.fillMaxWidth(),
            label = { Text("웹 앱 주소 (https://script.google.com/…/exec)") }, singleLine = true,
        )
        OutlinedTextField(
            key, { key = it }, Modifier.fillMaxWidth(), label = { Text("연결 비밀번호") }, singleLine = true,
            visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
        )
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(if (busy) "보내는 중…" else result ?: "아직 연결 안 함", fontSize = 12.sp, color = C.sub, modifier = Modifier.weight(1f))
            SmallButton(if (sync.configured) "지금 동기화" else "저장하고 연결") {
                if (busy) return@SmallButton
                sync.url = url
                sync.key = key
                if (!sync.configured) { result = "주소와 비밀번호를 둘 다 넣어 주세요"; return@SmallButton }
                busy = true
                scope.launch {
                    withContext(Dispatchers.IO) { SheetSync.syncNow(ctx) }
                    result = sync.lastResult
                    busy = false
                }
            }
        }
        if (sync.url != null) {
            Text(
                "연결 끊기", fontSize = 13.sp, color = C.warn,
                modifier = Modifier.clickable { sync.url = null; url = ""; result = null }.padding(vertical = 6.dp),
            )
        }
    }
}
