package com.nhhai.myscan.data

import kotlin.math.max
import kotlin.math.roundToInt

internal object PdfLayout {
    /** PDF points: A4 chooses orientation per page; image paper preserves the aspect ratio. */
    fun dimensions(width: Int, height: Int, paper: PdfPaper): Pair<Int, Int> {
        require(width > 0 && height > 0)
        return if (paper == PdfPaper.A4) {
            if (width > height) 842 to 595 else 595 to 842
        } else {
            val ratio = 842f / max(width, height)
            max(1, (width * ratio).roundToInt()) to max(1, (height * ratio).roundToInt())
        }
    }
}
