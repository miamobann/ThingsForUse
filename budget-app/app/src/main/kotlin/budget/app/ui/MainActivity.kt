package budget.app.ui

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import budget.app.data.Prefs

/** 파일 선택기·설정 화면을 열기 직전에 true로 두면 돌아왔을 때 다시 잠그지 않는다 */
object LockGuard {
    @Volatile
    var skipNext = false
}

/** 화면 이동 상태 */
sealed interface Screen {
    data object Home : Screen
    data object Calendar : Screen
    data object Stats : Screen
    data object Settings : Screen
    data object AddCash : Screen
    data object Import : Screen
    data object Uncategorized : Screen
    data object Unparsed : Screen
    data object Refunds : Screen
}

class MainActivity : FragmentActivity() {

    private var screen by mutableStateOf<Screen>(Screen.Home)
    private var openTx by mutableStateOf<Long?>(null)
    private var unlocked by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 잠금을 안 쓰는 동안은 풀린 상태로 시작 (설정에서 잠금을 켜도 바로 잠기지 않고 다음에 열 때부터)
        if (!Prefs(this).lockEnabled) unlocked = true
        handleIntent(intent)
        setContent {
            BudgetTheme {
                val prefs = Prefs(this)
                if (prefs.lockEnabled && !unlocked) {
                    LockScreen { authenticate() }
                } else {
                    App()
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val id = intent?.getLongExtra(EXTRA_TX, -1L) ?: -1L
        if (id > 0) {
            screen = Screen.Home
            openTx = id
        }
    }

    override fun onResume() {
        super.onResume()
        if (Prefs(this).lockEnabled && !unlocked) authenticate()
    }

    override fun onStop() {
        super.onStop()
        // 앱을 나갔다 오면 다시 잠근다 (파일 선택 창이나 설정 화면을 잠깐 다녀오는 건 제외)
        if (!isChangingConfigurations && !LockGuard.skipNext) unlocked = false
        LockGuard.skipNext = false
    }

    fun authenticate() {
        val authenticators = if (Build.VERSION.SDK_INT >= 30) {
            BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            BiometricManager.Authenticators.BIOMETRIC_WEAK
        }
        if (BiometricManager.from(this).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS &&
            Build.VERSION.SDK_INT >= 30
        ) {
            // 잠금 수단이 하나도 없는 폰이면 잠금을 쓸 수 없다
            unlocked = true
            return
        }
        val prompt = BiometricPrompt(
            this, ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    unlocked = true
                }
            },
        )
        val info = BiometricPrompt.PromptInfo.Builder().setTitle("가계부 잠금 해제")
        if (Build.VERSION.SDK_INT >= 30) {
            info.setAllowedAuthenticators(authenticators)
        } else {
            @Suppress("DEPRECATION")
            info.setDeviceCredentialAllowed(true)
        }
        prompt.authenticate(info.build())
    }

    @Composable
    private fun App() {
        BackHandler(enabled = screen != Screen.Home) {
            screen = when (screen) {
                Screen.Unparsed -> Screen.Settings
                else -> Screen.Home
            }
        }
        val go: (Screen) -> Unit = { screen = it }
        Column(Modifier.fillMaxSize().background(C.ground).systemBarsPadding()) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (screen) {
                    Screen.Home -> HomeScreen(go) { openTx = it }
                    Screen.Calendar -> CalendarScreen { openTx = it }
                    Screen.Stats -> StatsScreen()
                    Screen.Settings -> SettingsScreen(go)
                    Screen.AddCash -> AddCashScreen(onDone = { screen = Screen.Home })
                    Screen.Import -> ImportScreen(onDone = { screen = Screen.Home })
                    Screen.Uncategorized -> UncategorizedScreen(onBack = { screen = Screen.Home }) { openTx = it }
                    Screen.Unparsed -> UnparsedScreen(onBack = { screen = Screen.Settings })
                    Screen.Refunds -> RefundsScreen(onBack = { screen = Screen.Home }) { openTx = it }
                }
            }
            if (screen in listOf(Screen.Home, Screen.Calendar, Screen.Stats, Screen.Settings)) {
                BottomBar(screen) { screen = it }
            }
        }
        openTx?.let { id -> TxSheet(id) { openTx = null } }
    }

    companion object {
        const val EXTRA_TX = "tx"
    }
}

@Composable
private fun BottomBar(current: Screen, onSelect: (Screen) -> Unit) {
    Row(Modifier.fillMaxWidth().height(64.dp).background(C.card)) {
        listOf(Screen.Home to "홈", Screen.Calendar to "달력", Screen.Stats to "통계", Screen.Settings to "설정").forEach { (s, label) ->
            val on = s == current
            Box(
                Modifier.weight(1f).fillMaxHeight().clickable { onSelect(s) },
                contentAlignment = Alignment.Center,
            ) {
                Text(label, fontSize = 15.sp, fontWeight = if (on) FontWeight.Bold else FontWeight.Normal, color = if (on) C.accent else C.sub)
            }
        }
    }
}

@Composable
private fun LockScreen(onUnlock: () -> Unit) {
    Column(
        Modifier.fillMaxSize().background(C.ground).padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("가계부가 잠겨 있어요", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(20.dp))
        Button(onClick = onUnlock) { Text("잠금 해제") }
    }
}
