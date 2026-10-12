package com.nhhai.myscan.image

import com.nhhai.myscan.data.ScanPoint
import kotlin.math.hypot
import kotlin.math.roundToInt

/** Image coordinates increase downwards; the four corners wind clockwise. */
object ScanGeometry {
    fun fullCorners(): List<ScanPoint> = listOf(
        ScanPoint(0f, 0f), ScanPoint(1f, 0f), ScanPoint(1f, 1f), ScanPoint(0f, 1f),
    )

    fun normalizedRotation(rotation: Int): Int {
        require(rotation % 90 == 0) { "Chỉ hỗ trợ xoay theo góc 90°." }
        return ((rotation % 360) + 360) % 360
    }

    fun validate(corners: List<ScanPoint>): Boolean {
        if (corners.size != 4 || corners.any {
                !it.x.isFinite() || !it.y.isFinite() || it.x !in 0f..1f || it.y !in 0f..1f
            }) return false
        var twiceArea = 0f
        for (i in 0..3) {
            val a = corners[i]
            val b = corners[(i + 1) % 4]
            val c = corners[(i + 2) % 4]
            if (hypot(b.x - a.x, b.y - a.y) < .01f) return false
            val cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
            if (cross <= .00001f) return false
            twiceArea += a.x * b.y - b.x * a.y
        }
        return twiceArea >= .03f
    }

    /** Map a normalized source point to the display after clockwise rotation. */
    fun rotatePoint(point: ScanPoint, rotation: Int): ScanPoint = when (normalizedRotation(rotation)) {
        90 -> ScanPoint(1f - point.y, point.x)
        180 -> ScanPoint(1f - point.x, 1f - point.y)
        270 -> ScanPoint(point.y, 1f - point.x)
        else -> point
    }

    /** Reorder source points into their output TL, TR, BR, BL positions. */
    fun sourceCornersInOutputOrder(corners: List<ScanPoint>, rotation: Int): List<ScanPoint> {
        require(corners.size == 4)
        val steps = normalizedRotation(rotation) / 90
        return List(4) { corners[(it - steps + 4) % 4] }
    }

    fun displayCorners(corners: List<ScanPoint>, rotation: Int): List<ScanPoint> =
        sourceCornersInOutputOrder(corners, rotation).map { rotatePoint(it, rotation) }

    fun originalCorners(display: List<ScanPoint>, rotation: Int): List<ScanPoint> {
        require(display.size == 4)
        val angle = normalizedRotation(rotation)
        val steps = angle / 90
        val unrotated = display.map { rotatePoint(it, -angle) }
        return List(4) { unrotated[(it + steps) % 4] }
    }

    /** Average opposite sides keeps a perspective crop's resolution proportional. */
    fun outputSize(corners: List<ScanPoint>, width: Int, height: Int, rotation: Int, maxEdge: Int): Pair<Int, Int> {
        require(validate(corners) && width > 0 && height > 0 && maxEdge > 0)
        val points = sourceCornersInOutputOrder(corners, rotation)
        fun distance(a: Int, b: Int): Float = hypot(
            (points[a].x - points[b].x) * width,
            (points[a].y - points[b].y) * height,
        )
        val cropWidth = (distance(0, 1) + distance(3, 2)) / 2f
        val cropHeight = (distance(0, 3) + distance(1, 2)) / 2f
        val scale = minOf(1f, maxEdge.toFloat() / maxOf(cropWidth, cropHeight))
        return maxOf(1, (cropWidth * scale).roundToInt()) to maxOf(1, (cropHeight * scale).roundToInt())
    }

    /** Otsu threshold, bounded so faint paper does not become an all-black page. */
    fun binaryThreshold(histogram: IntArray): Int {
        require(histogram.size == 256 && histogram.all { it >= 0 })
        val count = histogram.sumOf { it.toLong() }
        val occupied = histogram.count { it > 0 }
        if (count == 0L || occupied < 2) return 128
        val total = histogram.indices.sumOf { it.toDouble() * histogram[it] }
        var backgroundCount = 0L
        var backgroundSum = 0.0
        var bestVariance = -1.0
        var threshold = 128
        for (tone in 0..254) {
            backgroundCount += histogram[tone]
            backgroundSum += tone.toDouble() * histogram[tone]
            val foregroundCount = count - backgroundCount
            if (backgroundCount == 0L || foregroundCount == 0L) continue
            val delta = backgroundSum / backgroundCount - (total - backgroundSum) / foregroundCount
            val variance = backgroundCount.toDouble() * foregroundCount * delta * delta
            if (variance > bestVariance) {
                bestVariance = variance
                threshold = tone
            }
        }
        return threshold.coerceIn(48, 220)
    }
}
