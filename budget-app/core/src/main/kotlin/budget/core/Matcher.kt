package budget.core

import java.time.Duration

/**
 * 새로 들어온 결제를 이미 저장된 거래와 비교해서 어떻게 처리할지 정한다.
 * - 같은 결제가 카드 알림·문자·파일로 여러 번 들어오면 한 건만 남긴다.
 * - 카드 결제와 네이버페이 알림은 금액이 같고 몇 분 안이면 한 건으로 합치고, 가게 이름은 네이버페이 쪽을 쓴다.
 * - 취소는 짝이 되는 결제를 찾아 취소 표시를 한다.
 */
object Matcher {

    /** 같은 결제로 볼 시간 차이 */
    const val CLOSE_MINUTES = 3L

    sealed interface Decision {
        /** 새 거래로 저장 */
        data object Insert : Decision

        /**
         * 이미 있는 거래. 승인번호처럼 비어 있던 정보만 채운다.
         * amount가 있으면 그 금액으로 고친다 (해외결제·가승인처럼 청구 금액이 알림과 다를 때 파일 쪽이 정확).
         */
        data class Duplicate(val existing: Tx, val approvalNo: String? = null, val amount: Long? = null) : Decision

        /** 카드 결제에 네이버페이 알림의 실제 가게 이름을 붙인다 */
        data class AttachNaverPay(val existing: Tx, val merchant: String) : Decision

        /**
         * 네이버페이 알림이 먼저 와 있던 결제에 카드 쪽 정보를 붙인다.
         * 포인트를 섞어 냈으면 카드 금액이 더 작은데, 실제로 나간 돈인 카드 금액으로 고친다.
         */
        data class AttachCard(val existing: Tx, val cardMerchant: String, val source: Source, val approvalNo: String?, val amount: Long) : Decision

        /** 기존 결제를 취소 처리 */
        data class Cancel(val target: Tx) : Decision

        /** 기록할 필요 없음 (예: 기록된 적 없는 가승인의 취소) */
        data object Ignore : Decision
    }

    /**
     * @param existing 비교할 기존 거래 (보통 앞뒤 며칠치)
     * @param consumed 파일 한 개를 가져오는 동안 이미 짝지어진 거래 id. 같은 금액 결제 두 건이 한 건에 몰리지 않게 한다.
     */
    fun decide(p: Parsed, existing: List<Tx>, consumed: Set<Long> = emptySet()): Decision {
        val pool = existing.filter { it.id !in consumed }

        // 취소는 이미 짝지어진 결제도 대상이 될 수 있어서 전체에서 찾는다
        if (p.cancelled) return decideCancelledApproval(p, existing)
        if (p.kind == Kind.CANCEL) return decideCancel(p, existing)

        p.approvalNo?.let { no -> pool.firstOrNull { it.approvalNo == no }?.let { return Decision.Duplicate(it) } }

        // 같은 경로에서 글자까지 똑같은 알림이 다시 오면(알림 갱신) 중복
        pool.firstOrNull { it.source == p.source && it.raw.isNotEmpty() && it.raw == p.raw && close(it, p) }
            ?.let { return Decision.Duplicate(it) }

        val sameAmount = pool.filter { it.amount == p.amount && it.kind != Kind.CANCEL && close(it, p) }
            .sortedBy { minutesApart(it, p) }

        when (p.source.channel) {
            Channel.NAVERPAY -> {
                sameAmount.firstOrNull { it.source.channel == Channel.CARD && !it.linkedNaverPay }
                    ?.let { return Decision.AttachNaverPay(it, p.merchant) }
                sameAmount.firstOrNull { it.source == Source.NAVERPAY && it.merchant == p.merchant }
                    ?.let { return Decision.Duplicate(it) }
                // 금액이 다른 같은 결제:
                // - 포인트+카드로 나눠 내면 카드 금액이 더 작다
                // - 네이버페이 알림 금액에 배송비가 빠져 있으면 카드 금액이 조금 더 크다
                // 카드에는 네이버 이름 대신 PG·가게 이름(이니시스, 나이스정보통신 등)이 찍히기도 해서,
                // 네이버 이름이 아니면 시각이 더 가까워야(1분) 같은 결제로 본다.
                pool.filter { it.source.channel == Channel.CARD && !it.linkedNaverPay && naverPayLike(it, p) }
                    .minByOrNull { minutesApart(it, p) }?.let { return Decision.AttachNaverPay(it, p.merchant) }
                // 한 주문이 네이버페이 알림 여러 개로 나뉘어 오는 경우: 이미 합쳐진 카드 결제에 같이 묶는다
                if (p.timeKnown) {
                    pool.filter {
                        it.source.channel == Channel.CARD && it.linkedNaverPay && it.kind == Kind.PAYMENT &&
                            it.timeKnown && it.amount > p.amount && minutesApart(it, p) <= CLOSE_MINUTES
                    }.minByOrNull { minutesApart(it, p) }?.let { return Decision.Duplicate(it) }
                }
            }
            Channel.CARD -> {
                // 다른 경로로 이미 들어온 같은 카드 결제 (알림 ↔ 문자 ↔ 파일)
                sameAmount.firstOrNull {
                    it.source.channel == Channel.CARD && it.source != p.source &&
                        (it.approvalNo == null || p.approvalNo == null) && merchantMatches(it, p)
                }?.let { return Decision.Duplicate(it, p.approvalNo) }
                // 파일끼리 겹치는 경우 (같은 파일을 두 번 올렸거나, 명세서와 실시간 내역이 겹침).
                // 승인번호가 둘 다 있으면 위에서 이미 비교했다.
                if (p.source == Source.CARD_FILE) {
                    sameAmount.firstOrNull {
                        it.source == Source.CARD_FILE && (it.approvalNo == null || p.approvalNo == null) && merchantMatches(it, p)
                    }
                        ?.let { return Decision.Duplicate(it, p.approvalNo) }
                }
                sameAmount.firstOrNull { it.source == Source.NAVERPAY && !it.linkedNaverPay }
                    ?.let { return Decision.AttachCard(it, p.merchant, p.source, p.approvalNo, p.amount) }
                pool.filter { it.source == Source.NAVERPAY && !it.linkedNaverPay && naverPayLike(p, it) }
                    .minByOrNull { minutesApart(it, p) }
                    ?.let { return Decision.AttachCard(it, p.merchant, p.source, p.approvalNo, p.amount) }
                // 해외결제·주유 등: 알림 금액과 청구(파일) 금액이 조금 다를 수 있다. 같은 가게·같은 날·10% 이내면 같은 결제.
                pool.filter {
                    it.source.channel == Channel.CARD && (it.source == Source.CARD_FILE) != (p.source == Source.CARD_FILE) &&
                        it.kind == Kind.PAYMENT &&
                        it.approvalNo == null && it.time.toLocalDate() == p.time.toLocalDate() &&
                        (Merchants.similar(it.originalMerchant, p.merchant)) &&
                        kotlin.math.abs(it.amount - p.amount) * 10 <= maxOf(it.amount, p.amount)
                }.minByOrNull { kotlin.math.abs(it.amount - p.amount) }?.let {
                    // 파일 금액이 실제 청구액이라 그쪽으로 맞춘다
                    return Decision.Duplicate(it, p.approvalNo, if (p.source == Source.CARD_FILE) p.amount else null)
                }
            }
            Channel.BANK -> {
                sameAmount.firstOrNull { it.source.channel == Channel.BANK && it.source != p.source }
                    ?.let { return Decision.Duplicate(it) }
                if (p.source == Source.BANK_FILE) {
                    sameAmount.firstOrNull { it.source == Source.BANK_FILE && Merchants.similar(it.originalMerchant, p.merchant) }
                        ?.let { return Decision.Duplicate(it) }
                }
            }
            Channel.MANUAL -> Unit
        }
        return Decision.Insert
    }

    /** 실시간 이용내역에 '취소'로 찍힌 승인: 기록된 결제가 있으면 취소, 없으면 무시 */
    private fun decideCancelledApproval(p: Parsed, pool: List<Tx>): Decision {
        val match = p.approvalNo?.let { no -> pool.firstOrNull { it.approvalNo == no } }
            ?: pool.filter { it.kind == Kind.PAYMENT && it.amount == p.amount && close(it, p) && merchantMatches(it, p) }
                .minByOrNull { minutesApart(it, p) }
            ?: return Decision.Ignore
        return if (match.cancelled) Decision.Duplicate(match, p.approvalNo) else Decision.Cancel(match)
    }

    private fun decideCancel(p: Parsed, pool: List<Tx>): Decision {
        val window = pool.filter {
            it.amount == p.amount && !it.time.isAfter(p.time.plusDays(1)) &&
                Duration.between(it.time, p.time).toDays() <= 90
        }
        // 이미 같은 취소가 들어와 있으면 중복
        window.firstOrNull { it.cancelled && merchantMatches(it, p) && sameDayOrClose(it, p) }?.let { return Decision.Duplicate(it) }
        window.firstOrNull { it.kind == Kind.CANCEL && merchantMatches(it, p) && sameDayOrClose(it, p) }?.let { return Decision.Duplicate(it) }
        // 같은 달 결제만 자동으로 취소 처리한다. 다음 달에 들어온 취소·환불은 그 달에 따로 남기고,
        // 사용자가 직접 상계하거나 고친다.
        val target = window
            .filter {
                it.kind == Kind.PAYMENT && !it.cancelled && merchantMatches(it, p) &&
                    java.time.YearMonth.from(it.time) == java.time.YearMonth.from(p.time)
            }
            .maxByOrNull { it.time }
        return if (target != null) Decision.Cancel(target) else Decision.Insert
    }

    /** 배송비로 보는 최대 차이 */
    const val SHIPPING_MAX = 5_000L

    /**
     * 카드 결제와 네이버페이 결제가 금액은 다르지만 같은 결제인지.
     * 카드가 더 작으면 포인트를 섞어 낸 것, 카드가 조금(배송비만큼) 더 크면 네이버페이 금액에 배송비가 빠진 것.
     */
    private fun naverPayLike(card: Tx, np: Parsed): Boolean = naverPayLike(card.amount, card.originalMerchant, card.kind, card.timeKnown, np.amount, np.timeKnown, minutesApart(card, np))

    private fun naverPayLike(card: Parsed, np: Tx): Boolean = naverPayLike(card.amount, card.merchant, card.kind, card.timeKnown, np.amount, np.timeKnown, minutesApart(np, card))

    private fun naverPayLike(
        cardAmount: Long, cardMerchant: String, cardKind: Kind, cardTimeKnown: Boolean,
        npAmount: Long, npTimeKnown: Boolean, minutes: Long,
    ): Boolean {
        if (cardKind != Kind.PAYMENT || !cardTimeKnown || !npTimeKnown || cardAmount == npAmount) return false
        val limit = if (isNaverAgent(cardMerchant)) CLOSE_MINUTES else 1L
        if (minutes > limit) return false
        return cardAmount < npAmount || cardAmount - npAmount <= SHIPPING_MAX
    }

    private fun isNaverAgent(name: String): Boolean = Merchants.key(name).let { it.contains("네이버파이낸셜") || it.contains("네이버페이") }

    private fun merchantMatches(t: Tx, p: Parsed): Boolean =
        Merchants.similar(t.originalMerchant, p.merchant) || Merchants.similar(t.merchant, p.merchant) ||
            // 같은 결제라도 경로마다 이름이 다르게 찍힐 수 있어서, 시각까지 아는 경우엔 금액+시각만으로도 본다
            (t.timeKnown && p.timeKnown && minutesApart(t, p) <= CLOSE_MINUTES)

    private fun minutesApart(t: Tx, p: Parsed): Long = kotlin.math.abs(Duration.between(t.time, p.time).toMinutes())

    private fun sameDayOrClose(t: Tx, p: Parsed): Boolean =
        t.time.toLocalDate() == p.time.toLocalDate() || minutesApart(t, p) <= CLOSE_MINUTES

    /** 시각을 둘 다 알면 몇 분 안, 하나라도 날짜만 알면 같은 날 */
    private fun close(t: Tx, p: Parsed): Boolean =
        if (t.timeKnown && p.timeKnown) minutesApart(t, p) <= CLOSE_MINUTES
        else t.time.toLocalDate() == p.time.toLocalDate()
}
