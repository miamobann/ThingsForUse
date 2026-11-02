package budget.app.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import budget.core.Kind
import budget.core.Merchants
import budget.core.Source
import budget.core.Tx
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.time.LocalDateTime
import java.util.concurrent.Executors

private class DbHelper(ctx: Context) : SQLiteOpenHelper(ctx, "budget.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE tx(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                time TEXT NOT NULL, time_known INTEGER NOT NULL,
                amount INTEGER NOT NULL, merchant TEXT NOT NULL, original_merchant TEXT NOT NULL,
                category TEXT, source TEXT NOT NULL, kind TEXT NOT NULL,
                cancelled INTEGER NOT NULL DEFAULT 0, include_in_spending INTEGER NOT NULL DEFAULT 1,
                approval_no TEXT, installment INTEGER NOT NULL DEFAULT 0,
                linked_np INTEGER NOT NULL DEFAULT 0, memo TEXT NOT NULL DEFAULT '', raw TEXT NOT NULL DEFAULT '')"""
        )
        db.execSQL("CREATE INDEX tx_time ON tx(time)")
        db.execSQL("CREATE TABLE rule(merchant_key TEXT PRIMARY KEY, category TEXT NOT NULL)")
        db.execSQL("CREATE TABLE unparsed(id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, origin TEXT NOT NULL, text TEXT NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
}

data class Unparsed(val id: Long, val time: LocalDateTime, val origin: String, val text: String)

/**
 * 앱 데이터 전부. 쓰기는 한 줄짜리 작업 스레드에서만 해서 알림·문자가 동시에 와도 순서대로 처리된다.
 * 화면은 [version]이 바뀌면 다시 읽는다.
 */
class Repository private constructor(ctx: Context) {
    private val db = DbHelper(ctx.applicationContext).writableDatabase
    val writer = Executors.newSingleThreadExecutor()

    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> = _version
    /** 내역이 바뀌면 부른다: 화면 새로고침 + 드라이브 자동 저장 예약 */
    var onChanged: (() -> Unit)? = null
    fun changed() {
        _version.value = _version.value + 1
        onChanged?.invoke()
    }

    // ---- 거래 ----

    fun all(): List<Tx> = query("SELECT * FROM tx ORDER BY time DESC, id DESC")

    fun between(from: LocalDateTime, to: LocalDateTime): List<Tx> =
        query("SELECT * FROM tx WHERE time >= ? AND time < ? ORDER BY time DESC, id DESC", from.toString(), to.toString())

    fun byId(id: Long): Tx? = query("SELECT * FROM tx WHERE id = ?", id.toString()).firstOrNull()

    fun uncategorized(): List<Tx> =
        query("SELECT * FROM tx WHERE category IS NULL AND cancelled = 0 ORDER BY time DESC")

    /** 아직 상계하지 않은 입금·다음 달 환불 */
    fun openRefunds(): List<Tx> =
        query("SELECT * FROM tx WHERE kind IN ('INCOME', 'CANCEL') AND cancelled = 0 ORDER BY time DESC")

    fun insert(t: Tx): Long = db.insert("tx", null, values(t))

    fun update(t: Tx) {
        db.update("tx", values(t), "id = ?", arrayOf(t.id.toString()))
    }

    fun delete(id: Long) {
        db.delete("tx", "id = ?", arrayOf(id.toString()))
    }

    fun deleteAll() {
        db.delete("tx", null, null)
        db.delete("rule", null, null)
        db.delete("unparsed", null, null)
    }

    /**
     * 카테고리를 정한다. remember면 같은 가게의 다음 결제부터 자동으로 쓰고,
     * 아직 분류 안 된 같은 가게 결제도 한꺼번에 채운다.
     * 결제대행사 이름만 있는 가게(네이버파이낸셜 등)는 기억하지 않는다.
     */
    fun setCategory(t: Tx, category: String, remember: Boolean) {
        update(t.copy(category = category))
        if (remember && !Merchants.isPaymentAgentOnly(t.merchant)) {
            val key = Merchants.key(t.merchant)
            db.insertWithOnConflict("rule", null, ContentValues().apply {
                put("merchant_key", key)
                put("category", category)
            }, SQLiteDatabase.CONFLICT_REPLACE)
            uncategorized().filter { Merchants.key(it.merchant) == key }.forEach { update(it.copy(category = category)) }
        }
    }

    fun ruleFor(merchant: String): String? {
        if (Merchants.isPaymentAgentOnly(merchant)) return null
        db.rawQuery("SELECT category FROM rule WHERE merchant_key = ?", arrayOf(Merchants.key(merchant))).use { c ->
            return if (c.moveToFirst()) c.getString(0) else null
        }
    }

    fun rules(): Map<String, String> {
        val out = mutableMapOf<String, String>()
        db.rawQuery("SELECT merchant_key, category FROM rule", null).use { c ->
            while (c.moveToNext()) out[c.getString(0)] = c.getString(1)
        }
        return out
    }

    fun putRule(key: String, category: String) {
        db.insertWithOnConflict("rule", null, ContentValues().apply {
            put("merchant_key", key)
            put("category", category)
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    // ---- 읽지 못한 알림 ----

    fun addUnparsed(origin: String, text: String, time: LocalDateTime = LocalDateTime.now()) {
        db.insert("unparsed", null, ContentValues().apply {
            put("time", time.toString())
            put("origin", origin)
            put("text", text)
        })
    }

    fun unparsed(): List<Unparsed> {
        val out = mutableListOf<Unparsed>()
        db.rawQuery("SELECT id, time, origin, text FROM unparsed ORDER BY id DESC LIMIT 200", null).use { c ->
            while (c.moveToNext()) out += Unparsed(c.getLong(0), LocalDateTime.parse(c.getString(1)), c.getString(2), c.getString(3))
        }
        return out
    }

    fun deleteUnparsed(id: Long?) {
        if (id == null) db.delete("unparsed", null, null) else db.delete("unparsed", "id = ?", arrayOf(id.toString()))
    }

    fun <T> transaction(block: () -> T): T {
        db.beginTransaction()
        try {
            val r = block()
            db.setTransactionSuccessful()
            return r
        } finally {
            db.endTransaction()
        }
    }

    // ---- 내부 ----

    private fun query(sql: String, vararg args: String): List<Tx> {
        val out = mutableListOf<Tx>()
        db.rawQuery(sql, arrayOf(*args)).use { c -> while (c.moveToNext()) out += read(c) }
        return out
    }

    private fun read(c: Cursor): Tx {
        fun s(n: String) = c.getString(c.getColumnIndexOrThrow(n))
        fun l(n: String) = c.getLong(c.getColumnIndexOrThrow(n))
        fun b(n: String) = l(n) != 0L
        return Tx(
            id = l("id"),
            time = LocalDateTime.parse(s("time")),
            timeKnown = b("time_known"),
            amount = l("amount"),
            merchant = s("merchant"),
            originalMerchant = s("original_merchant"),
            category = c.getColumnIndexOrThrow("category").let { if (c.isNull(it)) null else c.getString(it) },
            source = runCatching { Source.valueOf(s("source")) }.getOrDefault(Source.MANUAL),
            kind = runCatching { Kind.valueOf(s("kind")) }.getOrDefault(Kind.PAYMENT),
            cancelled = b("cancelled"),
            includeInSpending = b("include_in_spending"),
            approvalNo = c.getColumnIndexOrThrow("approval_no").let { if (c.isNull(it)) null else c.getString(it) },
            installmentMonths = l("installment").toInt(),
            linkedNaverPay = b("linked_np"),
            memo = s("memo"),
            raw = s("raw"),
        )
    }

    private fun values(t: Tx) = ContentValues().apply {
        put("time", t.time.withSecond(0).withNano(0).toString())
        put("time_known", if (t.timeKnown) 1 else 0)
        put("amount", t.amount)
        put("merchant", t.merchant)
        put("original_merchant", t.originalMerchant)
        if (t.category == null) putNull("category") else put("category", t.category)
        put("source", t.source.name)
        put("kind", t.kind.name)
        put("cancelled", if (t.cancelled) 1 else 0)
        put("include_in_spending", if (t.includeInSpending) 1 else 0)
        if (t.approvalNo == null) putNull("approval_no") else put("approval_no", t.approvalNo)
        put("installment", t.installmentMonths)
        put("linked_np", if (t.linkedNaverPay) 1 else 0)
        put("memo", t.memo)
        put("raw", t.raw)
    }

    companion object {
        @Volatile
        private var instance: Repository? = null
        fun get(ctx: Context): Repository = instance ?: synchronized(this) {
            instance ?: Repository(ctx).also { instance = it }
        }
    }
}
