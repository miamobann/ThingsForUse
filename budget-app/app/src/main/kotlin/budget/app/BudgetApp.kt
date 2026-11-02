package budget.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import budget.app.data.Export
import budget.app.data.Repository
import budget.app.data.SheetSync

class BudgetApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_BUDGET, "예산 알림", NotificationManager.IMPORTANCE_DEFAULT))
        nm.createNotificationChannel(NotificationChannel(CHANNEL_CATEGORY, "새 가게 분류", NotificationManager.IMPORTANCE_LOW))
        val repo = Repository.get(this)
        repo.onChanged = {
            Export.scheduleAutoSave(this)
            SheetSync.schedule(this)
        }
        repo.onCategoryEdited = { id, category -> SheetSync.markEdited(this, id, category) }
        repo.onWordRuleEdited = { word, category -> SheetSync.markRuleEdited(this, word, category) }
    }

    companion object {
        const val CHANNEL_BUDGET = "budget"
        const val CHANNEL_CATEGORY = "category"
    }
}
