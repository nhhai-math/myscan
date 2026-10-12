package com.nhhai.myscan.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ScanModelsTest {
    private val id = "00000000-0000-0000-0000-000000000001"

    @Test fun fullImageDefaultsAreValid() {
        val settings = EditSettings()
        assertEquals(0, settings.rotation)
        assertEquals(ColorMode.COLOR, settings.mode)
        assertEquals(listOf(ScanPoint(0f, 0f), ScanPoint(1f, 0f), ScanPoint(1f, 1f), ScanPoint(0f, 1f)), settings.corners)
    }

    @Test fun crossedOrCounterClockwiseCornersAreRejected() {
        val full = EditSettings().corners
        assertThrows(IllegalArgumentException::class.java) { EditSettings(corners = listOf(full[0], full[2], full[1], full[3])) }
        assertThrows(IllegalArgumentException::class.java) { EditSettings(corners = full.reversed()) }
        assertThrows(IllegalArgumentException::class.java) { EditSettings(corners = listOf(full[0], full[0], full[2], full[3])) }
    }

    @Test fun nonFiniteCoordinatesAndToneOrInvalidRotationAreRejected() {
        assertThrows(IllegalArgumentException::class.java) { ScanPoint(Float.NaN, .2f) }
        assertThrows(IllegalArgumentException::class.java) { ScanPoint(.2f, Float.POSITIVE_INFINITY) }
        assertThrows(IllegalArgumentException::class.java) { EditSettings(brightness = Float.NaN) }
        assertThrows(IllegalArgumentException::class.java) { EditSettings(contrast = 0f) }
        assertThrows(IllegalArgumentException::class.java) { EditSettings(rotation = 45) }
        assertThrows(IllegalArgumentException::class.java) { EditSettings(corners = emptyList()) }
    }

    @Test fun blankOrUntrimmedTitlesAndReversedTimestampsAreRejected() {
        assertThrows(IllegalArgumentException::class.java) { ScanDocument(id, "  ", 0, 0) }
        assertThrows(IllegalArgumentException::class.java) { ScanDocument(id, " Tài liệu ", 0, 0) }
        assertThrows(IllegalArgumentException::class.java) { ScanDocument(id, "Tài liệu", 1000, 500) }
        assertThrows(IllegalArgumentException::class.java) { ScanDocument(id, "x".repeat(MAX_DOCUMENT_TITLE_LENGTH + 1), 0, 0) }
    }

    @Test fun duplicateAndOversizedPageListsAreRejected() {
        val page = ScanPage(id, 100, 200, 100, 200, 0, 0)
        assertThrows(IllegalArgumentException::class.java) { ScanDocument(id, "Tài liệu", 0, 0, listOf(page, page)) }
        assertThrows(IllegalArgumentException::class.java) { ScanDocument(id, "Tài liệu", 0, 0, List(MAX_DOCUMENT_PAGES + 1) { page }) }
    }

    @Test fun a4OrientationFollowsEachPage() {
        assertEquals(595 to 842, PdfLayout.dimensions(1200, 1800, PdfPaper.A4))
        assertEquals(842 to 595, PdfLayout.dimensions(1800, 1200, PdfPaper.A4))
        assertEquals(595 to 842, PdfLayout.dimensions(1200, 1200, PdfPaper.A4))
    }

    @Test fun imagePaperFitsWithoutCroppingTheAspectRatio() {
        assertEquals(842 to 421, PdfLayout.dimensions(2000, 1000, PdfPaper.IMAGE_RATIO))
        assertEquals(421 to 842, PdfLayout.dimensions(1000, 2000, PdfPaper.IMAGE_RATIO))
        assertEquals(842 to 842, PdfLayout.dimensions(1000, 1000, PdfPaper.IMAGE_RATIO))
        assertThrows(IllegalArgumentException::class.java) { PdfLayout.dimensions(0, 1000, PdfPaper.IMAGE_RATIO) }
    }
}
