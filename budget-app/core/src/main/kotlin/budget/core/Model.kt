package budget.core

import java.time.LocalDateTime

/** 결제 정보가 어디서 왔는지. channel이 같으면 같은 결제가 여러 경로로 들어온 것일 수 있다. */
enum class Source(val label: String, val channel: Channel) {
    CARD_NOTI("카드 알림", Channel.CARD),
    CARD_SMS("카드 문자", Channel.CARD),
    CARD_FILE("카드 파일", Channel.CARD),
    NAVERPAY("네이버페이 알림", Channel.NAVERPAY),
    BANK_SMS("농협 문자", Channel.BANK),
    BANK_FILE("농협 파일", Channel.BANK),
    MANUAL("직접 입력", Channel.MANUAL),
}

enum class Channel { CARD, NAVERPAY, BANK, MANUAL }

enum class Kind {
    /** 일반 결제 */
    PAYMENT,

    /** 결제 취소·환불. 짝이 되는 결제를 못 찾으면 그만큼 지출에서 뺀다. */
    CANCEL,

    /** 계좌 이체·송금 */
    TRANSFER,

    /** 계좌 입금. 카테고리로 수입 / 돌려받은 돈 / 내 계좌 이동을 나눈다. 지출에는 안 들어간다. */
    INCOME,
}

/** 알림·문자·파일 한 줄에서 읽어낸 결제 한 건. 아직 저장 전. */
data class Parsed(
    val source: Source,
    val kind: Kind,
    val amount: Long,
    val merchant: String,
    val time: LocalDateTime,
    /** 파일의 월 명세서처럼 날짜만 있고 시각이 없으면 false */
    val timeKnown: Boolean = true,
    val installmentMonths: Int = 0,
    val approvalNo: String? = null,
    /** 실시간 이용내역에서 '취소'로 표시된 승인 (가승인 취소 등) */
    val cancelled: Boolean = false,
    val raw: String = "",
)

/** 저장된 거래 한 건 */
data class Tx(
    val id: Long,
    val time: LocalDateTime,
    val timeKnown: Boolean,
    val amount: Long,
    /** 화면에 보이는 가게 이름 (네이버페이 알림이 오면 실제 가게 이름으로 바뀐다) */
    val merchant: String,
    /** 카드사·은행이 찍어준 원래 이름. 취소 짝 찾기에 쓴다. */
    val originalMerchant: String,
    val category: String?,
    val source: Source,
    val kind: Kind,
    val cancelled: Boolean = false,
    val includeInSpending: Boolean = true,
    val approvalNo: String? = null,
    val installmentMonths: Int = 0,
    /** 카드 결제와 네이버페이 알림이 하나로 합쳐졌으면 true */
    val linkedNaverPay: Boolean = false,
    val memo: String = "",
    val raw: String = "",
    /** 상계: 이 환불·입금이 돌려준 결제의 id. 결제는 그대로 두고 통계에서 이만큼 줄여 센다. */
    val offsetOf: Long? = null,
)
