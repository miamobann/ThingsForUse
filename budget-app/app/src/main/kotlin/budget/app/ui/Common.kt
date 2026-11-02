package budget.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import budget.app.data.Repository
import budget.core.Categories
import budget.core.Kind
import budget.core.Tx
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.NumberFormat
import java.time.format.DateTimeFormatter
import java.util.Locale

object C {
    val ground = Color(0xFFF4F5F7)
    val card = Color.White
    val text = Color(0xFF17181A)
    val sub = Color(0xFF5B6068)
    val line = Color(0xFFEEF0F2)
    val border = Color(0xFFD5D8DD)
    val accent = Color(0xFF0B6E66)
    val accentDark = Color(0xFF08534D)
    val accentSoft = Color(0xFFE3F1EF)
    val accentMid = Color(0xFF9FD3CC)
    val warn = Color(0xFFB54708)
    val warnBar = Color(0xFFD9822B)
    val warnSoft = Color(0xFFFFF4E6)
    val warnText = Color(0xFF8A3A06)
    val muted = Color(0xFF8A8F98)

    private val palette = mapOf(
        "식비" to Color(0xFF2563EB), "카페·간식" to Color(0xFF9A3412), "교통" to Color(0xFF0B6E66),
        "쇼핑" to Color(0xFFC2620F), "구독" to Color(0xFF7C3AED), "여가" to Color(0xFFDB2777),
        "생활" to Color(0xFF0E7490), "의료" to Color(0xFFB91C1C), Categories.TRANSFER to Color(0xFF475569),
        "기타" to Color(0xFF6B7280), Categories.UNCATEGORIZED to Color(0xFF9AA1AB),
    )
    private val extra = listOf(Color(0xFF65A30D), Color(0xFF1D4ED8), Color(0xFFA16207), Color(0xFF7E22CE))

    fun category(name: String?): Color =
        palette[name ?: Categories.UNCATEGORIZED] ?: extra[(name.hashCode() and 0x7fffffff) % extra.size]
}

@Composable
fun BudgetTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = C.accent, onPrimary = Color.White, secondary = C.accent,
            background = C.ground, surface = C.card, onSurface = C.text, onBackground = C.text,
        ),
        content = content,
    )
}

private val wonFormat = NumberFormat.getNumberInstance(Locale.KOREA)
fun won(v: Long): String = wonFormat.format(v) + "원"
fun man(v: Long): String = when {
    v >= 10_000 -> "%.1f만".format(v / 10_000.0).replace(".0만", "만")
    v >= 1_000 -> "%.1f천".format(v / 1_000.0).replace(".0천", "천")
    else -> v.toString()
}

val MD_HM: DateTimeFormatter = DateTimeFormatter.ofPattern("M/d HH:mm")
val MD: DateTimeFormatter = DateTimeFormatter.ofPattern("M/d")

/** DB에서 읽은 값. 내역이 바뀌면 다시 읽는다. */
@Composable
fun <T> rememberData(vararg keys: Any?, load: (Repository) -> T): T? {
    val ctx = LocalContext.current
    val repo = Repository.get(ctx)
    val version by repo.version.collectAsState()
    val state = produceState<T?>(null, version, *keys) {
        value = withContext(Dispatchers.IO) { load(repo) }
    }
    return state.value
}

@Composable
fun Panel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier
            .padding(horizontal = 16.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(C.card)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        content = content,
    )
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 8.dp), fontSize = 16.sp, fontWeight = FontWeight.Bold, color = C.text)
}

@Composable
fun CategoryBadge(category: String?, size: Int = 36) {
    val name = category ?: Categories.UNCATEGORIZED
    Box(
        Modifier.size(size.dp).clip(RoundedCornerShape(10.dp)).background(C.category(name)),
        contentAlignment = Alignment.Center,
    ) {
        Text(name.take(2), color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold, maxLines = 1)
    }
}

@Composable
fun TxRow(t: Tx, onClick: () -> Unit) {
    val struck = t.cancelled || !t.includeInSpending
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CategoryBadge(t.category)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                t.merchant, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = if (struck) C.muted else C.text,
                textDecoration = if (t.cancelled) TextDecoration.LineThrough else null,
            )
            val bits = buildList {
                add(t.category ?: "미분류")
                add(if (t.timeKnown) t.time.format(MD_HM) else t.time.format(MD))
                if (t.cancelled) add("취소됨")
                budget.core.Installment.of(t)?.let { add("${it.months}개월 할부 · 남은 ${won(it.remaining)}") }
                if (!t.includeInSpending) add("지출 제외")
                add(t.source.label)
            }
            Text(bits.joinToString(" · "), fontSize = 12.sp, color = C.sub, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(8.dp))
        Text(
            sign(t) + won(t.amount),
            fontSize = 15.sp, fontWeight = FontWeight.Bold,
            color = if (struck) C.muted else C.text,
            textDecoration = if (t.cancelled) TextDecoration.LineThrough else null,
        )
    }
}

fun sign(t: Tx): String = when (t.kind) {
    Kind.CANCEL -> "-"
    Kind.INCOME -> "+"
    else -> ""
}

@Composable
fun Divider() {
    Box(Modifier.fillMaxWidth().height(1.dp).background(C.line))
}

@Composable
fun Chip(label: String, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier
            .height(44.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (selected) C.accentSoft else C.card)
            .border2(if (selected) C.accent else C.border)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label, fontSize = 14.sp, maxLines = 1,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            color = if (selected) C.accentDark else C.text,
        )
    }
}

private fun Modifier.border2(color: Color) =
    this.border(if (color == C.accent) 2.dp else 1.dp, color, RoundedCornerShape(12.dp))
