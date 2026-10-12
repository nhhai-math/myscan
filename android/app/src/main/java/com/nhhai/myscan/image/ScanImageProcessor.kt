package com.nhhai.myscan.image

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import androidx.exifinterface.media.ExifInterface
import com.nhhai.myscan.data.ColorMode
import com.nhhai.myscan.data.EditSettings
import java.io.File
import kotlin.math.roundToInt

/** All heavy operations run on the caller's worker, never inside a View callback. */
object ScanImageProcessor {
    const val EXPORT_MAX_EDGE = 2600
    const val PREVIEW_MAX_EDGE = 1000

    fun loadOriented(file: File, maxEdge: Int = EXPORT_MAX_EDGE): Bitmap {
        require(maxEdge > 0)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Không đọc được ảnh gốc." }
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxEdge) sample *= 2
        val rawEdge = maxOf(bounds.outWidth, bounds.outHeight)
        var bitmap = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
            // Native decode scaling avoids briefly keeping a 4000px photo plus its resized copy.
            if (rawEdge / sample > maxEdge) {
                inScaled = true
                inDensity = rawEdge
                inTargetDensity = maxEdge * sample
            }
        }) ?: error("Không đọc được ảnh gốc.")
        try {
            val orientation = ExifInterface(file).getAttributeInt(
                ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL,
            )
            val transform = Matrix().apply {
                when (orientation) {
                    ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                    ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                    ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
                    ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
                    ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                    ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(-90f); postScale(-1f, 1f) }
                    ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
                }
            }
            if (!transform.isIdentity) {
                val oriented = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, transform, true)
                if (oriented !== bitmap) { bitmap.recycle(); bitmap = oriented }
            }
            val edge = maxOf(bitmap.width, bitmap.height)
            if (edge > maxEdge) {
                val ratio = maxEdge.toFloat() / edge
                val resized = Bitmap.createScaledBitmap(bitmap,
                    maxOf(1, (bitmap.width * ratio).roundToInt()),
                    maxOf(1, (bitmap.height * ratio).roundToInt()), true)
                if (resized !== bitmap) { bitmap.recycle(); bitmap = resized }
            }
            bitmap.density = Bitmap.DENSITY_NONE
            return bitmap
        } catch (error: Throwable) {
            bitmap.recycle()
            throw error
        }
    }

    fun process(source: Bitmap, settings: EditSettings, maxEdge: Int = EXPORT_MAX_EDGE): Bitmap {
        require(!source.isRecycled && ScanGeometry.validate(settings.corners)) {
            "Kéo bốn góc quanh trang, tránh giao nhau hoặc vùng cắt quá nhỏ."
        }
        require(settings.brightness.isFinite() && settings.brightness in -1f..1f &&
            settings.contrast.isFinite() && settings.contrast in .25f..3f) { "Thiết lập ảnh không hợp lệ." }
        val (width, height) = ScanGeometry.outputSize(settings.corners, source.width, source.height,
            settings.rotation, maxEdge)
        val original = ScanGeometry.sourceCornersInOutputOrder(settings.corners, settings.rotation)
        val sourcePoints = original.flatMap { listOf(it.x * source.width, it.y * source.height) }.toFloatArray()
        val targetPoints = floatArrayOf(0f, 0f, width.toFloat(), 0f, width.toFloat(), height.toFloat(), 0f, height.toFloat())
        val transform = Matrix()
        require(transform.setPolyToPoly(sourcePoints, 0, targetPoints, 0, 4)) { "Không căn chỉnh được vùng cắt." }
        val result = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        try {
            val colors = ColorMatrix()
            if (settings.mode != ColorMode.COLOR) colors.setSaturation(0f)
            val contrast = settings.contrast
            val offset = settings.brightness * 255f + 127.5f * (1f - contrast)
            colors.postConcat(ColorMatrix(floatArrayOf(
                contrast, 0f, 0f, 0f, offset,
                0f, contrast, 0f, 0f, offset,
                0f, 0f, contrast, 0f, offset,
                0f, 0f, 0f, 1f, 0f,
            )))
            val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
                colorFilter = ColorMatrixColorFilter(colors)
            }
            Canvas(result).apply { drawColor(Color.WHITE); drawBitmap(source, transform, paint) }
            if (settings.mode == ColorMode.BLACK_WHITE) threshold(result)
            return result
        } catch (error: Throwable) {
            result.recycle()
            throw error
        }
    }

    private fun threshold(bitmap: Bitmap) {
        // Reuse one scanline instead of allocating an array for the whole photo.
        val row = IntArray(bitmap.width)
        val histogram = IntArray(256)
        for (y in 0 until bitmap.height) {
            if (Thread.currentThread().isInterrupted) throw InterruptedException()
            bitmap.getPixels(row, 0, bitmap.width, 0, y, bitmap.width, 1)
            row.forEach { histogram[Color.red(it)]++ }
        }
        val threshold = ScanGeometry.binaryThreshold(histogram)
        for (y in 0 until bitmap.height) {
            if (Thread.currentThread().isInterrupted) throw InterruptedException()
            bitmap.getPixels(row, 0, bitmap.width, 0, y, bitmap.width, 1)
            for (x in row.indices) row[x] = if (Color.red(row[x]) > threshold) Color.WHITE else Color.BLACK
            bitmap.setPixels(row, 0, bitmap.width, 0, y, bitmap.width, 1)
        }
    }
}
