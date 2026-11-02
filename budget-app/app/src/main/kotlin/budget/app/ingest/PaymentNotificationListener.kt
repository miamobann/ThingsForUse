package budget.app.ingest

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import budget.app.data.Repository
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * 현대카드·네이버페이 앱의 알림을 읽는다. 다른 앱 알림은 내용을 보지 않고 넘긴다.
 * (문자 권한이 없을 때만 문자 앱 알림을 대신 읽는다.)
 */
class PaymentNotificationListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val pkg = sbn.packageName ?: return
        if (pkg == packageName) return
        val watched = pkg.contains("hyundaicard") || pkg.contains("naverfin") || pkg == "com.nhn.android.search" ||
            pkg.contains("messaging") || pkg == "com.android.mms"
        if (!watched) return
        if (sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return

        val ex = sbn.notification.extras
        val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val lines = ex.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.joinToString("\n")
        val text = (ex.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: lines ?: ex.getCharSequence(Notification.EXTRA_TEXT))
            ?.toString() ?: return
        val posted = LocalDateTime.ofInstant(Instant.ofEpochMilli(sbn.postTime), ZoneId.systemDefault())

        val repo = Repository.get(this)
        repo.writer.execute {
            runCatching { Ingest.fromNotification(this, pkg, title, text, posted) }
                .onFailure { repo.addUnparsed("오류 ($pkg)", "${it.message}\n$title\n$text", posted) }
        }
    }
}
