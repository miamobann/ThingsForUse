package budget.app.ingest

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import budget.app.data.Repository
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId

/** 농협 출금 문자, 현대카드 결제 문자 */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val body = msgs.joinToString("") { it.messageBody ?: "" }
        if (!body.contains("농협") && !body.contains("현대")) return
        val time = msgs.firstOrNull()?.timestampMillis?.let {
            LocalDateTime.ofInstant(Instant.ofEpochMilli(it), ZoneId.systemDefault())
        } ?: LocalDateTime.now()

        val pending = goAsync()
        val repo = Repository.get(ctx)
        repo.writer.execute {
            try {
                Ingest.fromSms(ctx.applicationContext, body, time)
            } catch (e: Exception) {
                repo.addUnparsed("오류 (문자)", "${e.message}\n$body", time)
            } finally {
                pending.finish()
            }
        }
    }
}
