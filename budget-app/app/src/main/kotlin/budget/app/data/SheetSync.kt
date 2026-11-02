package budget.app.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * 구글 시트 연동 (앱스 스크립트 웹 앱).
 *
 * 한 번 부를 때 하는 일:
 * 1. 앱에서 고친 분류(edits)를 보낸다 → 스크립트가 시트2 '분류 자료'의 건별 대분류에 적는다
 * 2. 앱 내역 전체(rows, CSV와 같은 17개 열)를 보낸다 → 스크립트가 시트1 '내역'을 통째로 다시 쓴다
 * 3. 시트2의 건별 대분류(categories)를 받아 앱 내역에 반영한다 (분석 화면에서 고친 분류)
 *
 * 인터넷이 안 되면 실패로 두고, 다음에 내역이 바뀌거나 앱을 열 때 다시 보낸다. 고친 분류는 보낼 때까지 남겨 둔다.
 */
object SheetSync {

    const val PROTOCOL = 1

    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private var pending: ScheduledFuture<*>? = null

    @Synchronized
    fun schedule(ctx: Context, delaySeconds: Long = 5) {
        if (!SyncSettings(ctx).configured) return
        pending?.cancel(false)
        pending = scheduler.schedule({ runCatching { syncNow(ctx) } }, delaySeconds, TimeUnit.SECONDS)
    }

    /** 앱 안에서 분류가 바뀐 건을 기록해 둔다 (다음 동기화 때 시트로 보냄) */
    fun markEdited(ctx: Context, id: Long, category: String?) {
        val s = SyncSettings(ctx)
        if (!s.configured) return
        s.edits = s.edits + (id to (category ?: ""))
    }

    /** @return 실패하면 이유, 성공하면 null */
    fun syncNow(ctx: Context): String? {
        val s = SyncSettings(ctx)
        val url = s.url ?: return "연결 주소가 없어요"
        val repo = Repository.get(ctx)
        val sentEdits = s.edits
        val body = JSONObject().apply {
            put("protocol", PROTOCOL)
            put("key", s.key)
            put("action", "sync")
            put("edits", JSONArray().apply {
                sentEdits.forEach { (id, c) -> put(JSONObject().put("id", id.toString()).put("category", c)) }
            })
            put("rows", JSONArray().apply { Export.rows(repo.all(), Prefs(ctx).cutoffDay).forEach { put(JSONArray(it)) } })
        }
        val result = runCatching { JSONObject(post(url, body.toString())) }
        val error = result.fold(
            onSuccess = { res ->
                if (!res.optBoolean("ok")) res.optString("error", "시트에서 거절했어요")
                else {
                    // 보낸 수정만 지운다 (보내는 사이에 새로 고친 건 남김)
                    s.edits = s.edits.filter { (id, c) -> sentEdits[id] != c }
                    applyCategories(ctx, res.optJSONArray("categories"))
                    null
                }
            },
            onFailure = { "연결 실패: ${it.message ?: it.javaClass.simpleName}" },
        )
        s.lastResult = error ?: "동기화됨 ${LocalDateTime.now().format(DateTimeFormatter.ofPattern("M/d HH:mm"))}"
        return error
    }

    /** 시트2에서 받은 건별 대분류 중 앱과 다른 것만 고친다. 아직 못 보낸 앱 쪽 수정이 있는 건은 앱이 우선. */
    private fun applyCategories(ctx: Context, arr: JSONArray?) {
        if (arr == null || arr.length() == 0) return
        val repo = Repository.get(ctx)
        val waiting = SyncSettings(ctx).edits
        val remote = (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val id = o.optString("id").toLongOrNull() ?: return@mapNotNull null
            id to o.optString("category").ifBlank { null }
        }.toMap()
        var changed = 0
        repo.writer.submit {
            repo.transaction {
                for ((id, category) in remote) {
                    if (id in waiting || category == null) continue
                    val t = repo.byId(id) ?: continue
                    if (t.category != category) {
                        repo.update(budget.core.MoneyFlow.withCategory(t, category), fromSync = true)
                        changed++
                    }
                }
            }
            if (changed > 0) repo.changed()
        }.get()
    }

    /** 앱스 스크립트는 POST를 처리한 뒤 결과 주소로 넘겨준다(302). 그 주소를 GET으로 읽는다. */
    private fun post(url: String, body: String): String {
        var conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            instanceFollowRedirects = false
            connectTimeout = 15_000
            readTimeout = 60_000
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        var hops = 0
        while (conn.responseCode in 300..399 && hops++ < 5) {
            val next = conn.getHeaderField("Location") ?: break
            conn.disconnect()
            conn = (URL(next).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = 15_000
                readTimeout = 60_000
            }
        }
        val code = conn.responseCode
        val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
        conn.disconnect()
        if (code == 401 || code == 403) error("시트가 로그인을 요구해요(HTTP $code). 배포 액세스를 '모든 사용자'로 바꾸고, 주소가 /exec로 끝나는지 확인해 주세요")
        if (code !in 200..299) error("HTTP $code")
        if (!text.trimStart().startsWith("{")) error("시트 응답이 이상해요. 웹 앱을 '모든 사용자'로 배포했는지 확인해 주세요")
        return text
    }
}

/** 시트 연동 설정 */
class SyncSettings(ctx: Context) {
    private val p = ctx.applicationContext.getSharedPreferences("sheet_sync", Context.MODE_PRIVATE)

    var url: String?
        get() = p.getString("url", null)?.takeIf { it.isNotBlank() }
        set(v) = p.edit().putString("url", v?.trim()).apply()

    var key: String
        get() = p.getString("key", "") ?: ""
        set(v) = p.edit().putString("key", v.trim()).apply()

    val configured: Boolean get() = url != null && key.isNotEmpty()

    /** 아직 시트로 못 보낸 분류 수정: id → 카테고리("" = 분류 없음) */
    var edits: Map<Long, String>
        get() {
            val o = runCatching { JSONObject(p.getString("edits", "{}")!!) }.getOrDefault(JSONObject())
            return o.keys().asSequence().mapNotNull { k -> k.toLongOrNull()?.let { it to o.getString(k) } }.toMap()
        }
        set(v) = p.edit().putString("edits", JSONObject().apply { v.forEach { (k, c) -> put(k.toString(), c) } }.toString()).apply()

    var lastResult: String?
        get() = p.getString("last", null)
        set(v) = p.edit().putString("last", v).apply()
}
