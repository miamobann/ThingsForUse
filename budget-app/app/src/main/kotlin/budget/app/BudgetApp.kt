package budget.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import budget.app.data.Export
import budget.app.data.Repository

class BudgetApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_BUDGET, "예산 알림", NotificationManager.IMPORTANCE_DEFAULT))
        nm.createNotificationChannel(NotificationChannel(CHANNEL_CATEGORY, "새 가게 분류", NotificationManager.IMPORTANCE_LOW))
        Repository.get(this).onChanged = { Export.scheduleAutoSave(this) }
    }

    companion object {
        const val CHANNEL_BUDGET = "budget"
        const val CHANNEL_CATEGORY = "category"
    }
}
