package budget.app.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Context
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import budget.core.Autocomplete
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val DATE_LABEL = DateTimeFormatter.ofPattern("yyyy년 M월 d일 (E)")
private val TIME_LABEL = DateTimeFormatter.ofPattern("HH:mm")

/** 달력에서 날짜 고르기. 오늘 이후는 못 고른다. */
fun pickDate(ctx: Context, current: LocalDate, onPick: (LocalDate) -> Unit) {
    DatePickerDialog(ctx, { _, y, m, d -> onPick(LocalDate.of(y, m + 1, d)) }, current.year, current.monthValue - 1, current.dayOfMonth).apply {
        datePicker.maxDate = LocalDate.now().plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli() - 1
    }.show()
}

fun pickTime(ctx: Context, current: LocalTime?, onPick: (LocalTime) -> Unit) {
    val t = current ?: LocalTime.now()
    TimePickerDialog(ctx, { _, h, m -> onPick(LocalTime.of(h, m)) }, t.hour, t.minute, true).show()
}

/**
 * 날짜·시각 입력. time이 null이면 '시각 모름'.
 * 빠른 칩(오늘·어제·그저께) + 달력, 시각은 넣기·바꾸기·모름으로.
 */
@Composable
fun DateTimeInput(date: LocalDate, time: LocalTime?, onDate: (LocalDate) -> Unit, onTime: (LocalTime?) -> Unit, quickChips: Boolean = true) {
    val ctx = LocalContext.current
    val today = LocalDate.now()
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("날짜", fontSize = 13.sp, color = C.sub)
        if (quickChips) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("오늘" to today, "어제" to today.minusDays(1), "그저께" to today.minusDays(2))
                .forEach { (label, d) -> Chip(label, date == d, Modifier.weight(1f)) { onDate(d) } }
            Chip("달력", date.isBefore(today.minusDays(2)), Modifier.weight(1f)) { pickDate(ctx, date, onDate) }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                date.format(DATE_LABEL), fontSize = 15.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.weight(1f).clip(RoundedCornerShape(8.dp)).clickable { pickDate(ctx, date, onDate) }.padding(vertical = 6.dp),
            )
            Text(
                time?.format(TIME_LABEL) ?: "시각 모름", fontSize = 15.sp,
                color = if (time == null) C.sub else C.text,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { pickTime(ctx, time) { onTime(it) } }.padding(6.dp),
            )
            Text(
                if (time == null) "시각 넣기" else "모름으로", fontSize = 13.sp, color = C.accentDark,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable {
                    if (time == null) pickTime(ctx, null) { onTime(it) } else onTime(null)
                }.padding(6.dp),
            )
        }
    }
}

/**
 * 자동 완성 입력칸. 한 글자부터 아래에 후보 5개. 누르면 채우고, 길게 누르면 후보에서 숨긴다.
 * @param onPick 후보를 골랐을 때 (가게명이면 카테고리 자동 선택에 쓴다)
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun AutoField(
    value: String,
    onValue: (String) -> Unit,
    label: String,
    candidates: List<Autocomplete.Candidate>,
    onHide: (String) -> Unit,
    onPick: (String) -> Unit = {},
) {
    var focused by remember { mutableStateOf(false) }
    var picked by remember { mutableStateOf<String?>(null) }
    val list = if (focused && picked != value) Autocomplete.suggest(candidates, value) else emptyList()
    Column {
        OutlinedTextField(
            value, { onValue(it); picked = null },
            Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused },
            label = { Text(label) }, singleLine = true,
        )
        if (list.isNotEmpty()) Column(
            Modifier.fillMaxWidth().padding(top = 4.dp).clip(RoundedCornerShape(12.dp)).background(C.card),
        ) {
            list.forEachIndexed { i, c ->
                if (i > 0) Divider()
                Row(
                    Modifier.fillMaxWidth()
                        .combinedClickable(
                            onClick = { picked = c.text; onValue(c.text); onPick(c.text) },
                            onLongClick = { onHide(c.text) },
                        )
                        .padding(horizontal = 14.dp, vertical = 11.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(c.text, fontSize = 15.sp, modifier = Modifier.weight(1f), maxLines = 1)
                    Text("${c.count}번", fontSize = 12.sp, color = C.sub)
                }
            }
            Text("길게 누르면 목록에서 숨겨요", fontSize = 11.sp, color = C.muted, modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp))
        }
    }
}
