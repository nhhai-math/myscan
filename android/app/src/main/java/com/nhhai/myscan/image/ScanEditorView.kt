package com.nhhai.myscan.image

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import com.nhhai.myscan.data.ScanPoint
import kotlin.math.hypot

/** Fit-to-screen image view with touch handles mapped into original image coordinates. */
class ScanEditorView(context: Context) : View(context) {
    var onCornersChanged: ((List<ScanPoint>) -> Unit)? = null
    var onGestureStarted: (() -> Unit)? = null
    var editable = true
    private var bitmap: Bitmap? = null
    private var rotation = 0
    private var corners = ScanGeometry.fullCorners()
    private var cropMode = true
    private var activeHandle = -1
    private val imageBounds = RectF()
    private val imagePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val shadePaint = Paint().apply { color = 0x99091820.toInt() }
    private val outlinePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(92, 229, 187); style = Paint.Style.STROKE; strokeWidth = dp(2f)
    }
    private val handlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val handleBorder = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(13, 133, 108); style = Paint.Style.STROKE; strokeWidth = dp(3f)
    }

    init {
        setBackgroundColor(Color.rgb(20, 42, 44))
        contentDescription = "Vùng chỉnh ảnh. Kéo bốn góc xanh để căn thẳng trang tài liệu."
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        isFocusable = true
    }

    fun setSource(source: Bitmap?, angle: Int, originalCorners: List<ScanPoint>) {
        bitmap = source
        rotation = ScanGeometry.normalizedRotation(angle)
        corners = originalCorners.toList()
        cropMode = true
        updateBounds()
        invalidate()
    }

    fun setPreview(preview: Bitmap?) {
        bitmap = preview
        rotation = 0
        cropMode = false
        updateBounds()
        invalidate()
    }

    private fun dp(value: Float) = value * resources.displayMetrics.density

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) = updateBounds()

    private fun updateBounds() {
        val source = bitmap ?: return
        val sideways = rotation == 90 || rotation == 270
        val imageWidth = if (sideways) source.height else source.width
        val imageHeight = if (sideways) source.width else source.height
        val availableWidth = maxOf(1f, width - dp(48f))
        val availableHeight = maxOf(1f, height - dp(48f))
        val scale = minOf(availableWidth / imageWidth, availableHeight / imageHeight)
        val fittedWidth = imageWidth * scale
        val fittedHeight = imageHeight * scale
        imageBounds.set((width - fittedWidth) / 2f, (height - fittedHeight) / 2f,
            (width + fittedWidth) / 2f, (height + fittedHeight) / 2f)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val source = bitmap ?: return
        if (source.isRecycled || imageBounds.isEmpty) return
        val sourcePoints = ScanGeometry.sourceCornersInOutputOrder(ScanGeometry.fullCorners(), rotation)
            .flatMap { listOf(it.x * source.width, it.y * source.height) }.toFloatArray()
        val target = floatArrayOf(imageBounds.left, imageBounds.top, imageBounds.right, imageBounds.top,
            imageBounds.right, imageBounds.bottom, imageBounds.left, imageBounds.bottom)
        val transform = Matrix().apply { setPolyToPoly(sourcePoints, 0, target, 0, 4) }
        canvas.drawBitmap(source, transform, imagePaint)
        if (!cropMode) return
        val display = ScanGeometry.displayCorners(corners, rotation)
        val points = display.map { PointF(imageBounds.left + it.x * imageBounds.width(),
            imageBounds.top + it.y * imageBounds.height()) }
        val pagePath = Path().apply {
            moveTo(points[0].x, points[0].y)
            points.drop(1).forEach { lineTo(it.x, it.y) }
            close()
        }
        val shade = Path().apply {
            fillType = Path.FillType.EVEN_ODD
            addRect(imageBounds, Path.Direction.CW)
            addPath(pagePath)
        }
        canvas.drawPath(shade, shadePaint)
        canvas.drawPath(pagePath, outlinePaint)
        points.forEach {
            canvas.drawCircle(it.x, it.y, dp(10f), handlePaint)
            canvas.drawCircle(it.x, it.y, dp(10f), handleBorder)
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (!cropMode || !editable || bitmap == null || imageBounds.isEmpty) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val display = ScanGeometry.displayCorners(corners, rotation)
                activeHandle = display.indices.minByOrNull {
                    hypot(event.x - imageBounds.left - display[it].x * imageBounds.width(),
                        event.y - imageBounds.top - display[it].y * imageBounds.height())
                } ?: -1
                if (activeHandle < 0) return false
                val nearest = display[activeHandle]
                val distance = hypot(event.x - imageBounds.left - nearest.x * imageBounds.width(),
                    event.y - imageBounds.top - nearest.y * imageBounds.height())
                if (distance > dp(36f)) { activeHandle = -1; return false }
                parent.requestDisallowInterceptTouchEvent(true)
                onGestureStarted?.invoke()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (activeHandle < 0) return false
                val display = ScanGeometry.displayCorners(corners, rotation).toMutableList()
                display[activeHandle] = ScanPoint(
                    ((event.x - imageBounds.left) / imageBounds.width()).coerceIn(0f, 1f),
                    ((event.y - imageBounds.top) / imageBounds.height()).coerceIn(0f, 1f),
                )
                val original = ScanGeometry.originalCorners(display, rotation)
                if (ScanGeometry.validate(original)) {
                    corners = original
                    onCornersChanged?.invoke(original)
                    invalidate()
                }
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (activeHandle < 0) return false
                activeHandle = -1
                parent.requestDisallowInterceptTouchEvent(false)
                if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
                return true
            }
        }
        return true
    }

    override fun performClick(): Boolean { super.performClick(); return true }
}
