package com.nhhai.myscan.data

import kotlin.math.abs

const val MAX_IMAGE_EDGE = 4000
const val MAX_DOCUMENT_PAGES = 200
const val MAX_DOCUMENT_TITLE_LENGTH = 160

internal fun requireScanId(id: String) {
    require(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").matches(id)) {
        "Mã tài liệu hoặc trang không hợp lệ."
    }
}

enum class ColorMode { COLOR, GRAYSCALE, BLACK_WHITE }
enum class PdfPaper { A4, IMAGE_RATIO }

/** Coordinates refer to the original, upright image, before editing or rotation. */
data class ScanPoint(val x: Float, val y: Float) {
    init {
        require(x.isFinite() && y.isFinite() && x in 0f..1f && y in 0f..1f) {
            "Góc giấy phải nằm trong ảnh."
        }
    }
}

data class EditSettings(
    val rotation: Int = 0,
    val corners: List<ScanPoint> = listOf(
        ScanPoint(0f, 0f), ScanPoint(1f, 0f), ScanPoint(1f, 1f), ScanPoint(0f, 1f),
    ),
    val mode: ColorMode = ColorMode.COLOR,
    val brightness: Float = 0f,
    val contrast: Float = 1f,
) {
    init {
        validate()
    }

    fun validate() {
        require(rotation in setOf(0, 90, 180, 270)) { "Chỉ có thể xoay từng bước 90 độ." }
        require(brightness.isFinite() && brightness in -1f..1f) { "Độ sáng không hợp lệ." }
        require(contrast.isFinite() && contrast in .25f..3f) { "Độ tương phản không hợp lệ." }
        require(corners.size == 4) { "Cần chọn đủ bốn góc giấy." }
        var twiceArea = 0f
        for (index in corners.indices) {
            val current = corners[index]
            val next = corners[(index + 1) % 4]
            val following = corners[(index + 2) % 4]
            require(current.x.isFinite() && current.y.isFinite() && current.x in 0f..1f && current.y in 0f..1f) {
                "Góc giấy phải nằm trong ảnh."
            }
            val cross = (next.x - current.x) * (following.y - next.y) -
                (next.y - current.y) * (following.x - next.x)
            require(cross > .00001f) { "Bốn góc giấy phải tạo thành tứ giác lồi theo chiều kim đồng hồ." }
            twiceArea += current.x * next.y - next.x * current.y
        }
        require(abs(twiceArea) > .0002f) { "Vùng cắt quá nhỏ." }
    }
}

data class ScanPage(
    val id: String,
    val width: Int,
    val height: Int,
    val originalWidth: Int,
    val originalHeight: Int,
    val createdAt: Long,
    val updatedAt: Long,
    val edit: EditSettings? = null,
) {
    init {
        requireScanId(id)
        require(listOf(width, height, originalWidth, originalHeight).all { it in 1..MAX_IMAGE_EDGE }) {
            "Kích thước ảnh không hợp lệ."
        }
        require(createdAt >= 0 && updatedAt >= createdAt) { "Thời gian của trang không hợp lệ." }
        edit?.validate()
    }
}

data class ScanDocument(
    val id: String,
    val title: String,
    val createdAt: Long,
    val updatedAt: Long,
    val pages: List<ScanPage> = emptyList(),
) {
    init {
        requireScanId(id)
        require(title.isNotBlank() && title == title.trim() && title.length <= MAX_DOCUMENT_TITLE_LENGTH) {
            "Tên tài liệu cần có từ 1 đến $MAX_DOCUMENT_TITLE_LENGTH ký tự."
        }
        require(createdAt >= 0 && updatedAt >= createdAt) { "Thời gian của tài liệu không hợp lệ." }
        require(pages.size <= MAX_DOCUMENT_PAGES) { "Mỗi tài liệu chỉ có tối đa $MAX_DOCUMENT_PAGES trang." }
        require(pages.map { it.id }.distinct().size == pages.size) { "Một trang không thể xuất hiện hai lần." }
    }
}
