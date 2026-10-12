package com.nhhai.myscan.image

import com.nhhai.myscan.data.ScanPoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanGeometryTest {
    private val skewed = listOf(
        ScanPoint(.13f, .07f), ScanPoint(.92f, .16f), ScanPoint(.84f, .93f), ScanPoint(.05f, .79f),
    )

    @Test fun `clockwise paper succeeds and crossed or collapsed crop fails`() {
        assertTrue(ScanGeometry.validate(skewed))
        assertFalse(ScanGeometry.validate(skewed.reversed()))
        assertFalse(ScanGeometry.validate(listOf(skewed[0], skewed[2], skewed[1], skewed[3])))
        assertFalse(ScanGeometry.validate(listOf(
            ScanPoint(.1f, .1f), ScanPoint(.2f, .1f), ScanPoint(.2f, .11f), ScanPoint(.1f, .11f),
        )))
        assertFalse(ScanGeometry.validate(listOf(skewed[0], skewed[0], skewed[2], skewed[3])))
    }

    @Test fun `dragged corners retain original coordinates after each rotation`() {
        for (rotation in listOf(0, 90, 180, 270)) {
            val display = ScanGeometry.displayCorners(skewed, rotation)
            assertTrue(ScanGeometry.validate(display))
            val restored = ScanGeometry.originalCorners(display, rotation)
            skewed.indices.forEach {
                assertEquals(skewed[it].x, restored[it].x, .000001f)
                assertEquals(skewed[it].y, restored[it].y, .000001f)
            }
        }
    }

    @Test fun `dragging rotated top left edits original bottom left`() {
        val display = ScanGeometry.displayCorners(ScanGeometry.fullCorners(), 90).toMutableList()
        display[0] = ScanPoint(.2f, .1f)
        val original = ScanGeometry.originalCorners(display, 90)
        assertEquals(.1f, original[3].x, .000001f)
        assertEquals(.8f, original[3].y, .000001f)
        assertEquals(ScanPoint(0f, 0f), original[0])
        assertTrue(ScanGeometry.validate(original))
    }

    @Test fun `rotation changes output direction without changing cropped content`() {
        val forward = ScanGeometry.outputSize(skewed, 2000, 3000, 0, 2600)
        val clockwise = ScanGeometry.outputSize(skewed, 2000, 3000, 90, 2600)
        assertEquals(forward.first, clockwise.second)
        assertEquals(forward.second, clockwise.first)
        assertEquals(ScanPoint(0f, 1f), ScanGeometry.sourceCornersInOutputOrder(ScanGeometry.fullCorners(), 90)[0])
        assertEquals(1200 to 800, ScanGeometry.outputSize(ScanGeometry.fullCorners(), 800, 1200, 90, 2600))
    }

    @Test fun `export and preview limit long edge and never upscale small originals`() {
        assertEquals(1733 to 2600, ScanGeometry.outputSize(ScanGeometry.fullCorners(), 4000, 6000, 0, 2600))
        assertEquals(667 to 1000, ScanGeometry.outputSize(ScanGeometry.fullCorners(), 4000, 6000, 0, 1000))
        assertEquals(300 to 450, ScanGeometry.outputSize(ScanGeometry.fullCorners(), 300, 450, 0, 2600))
    }

    @Test fun `binary threshold separates dark ink from dim paper`() {
        val dimPage = IntArray(256).apply { this[70] = 100; this[170] = 2000 }
        val threshold = ScanGeometry.binaryThreshold(dimPage)
        assertTrue(70 <= threshold && threshold < 170)
        assertEquals(128, ScanGeometry.binaryThreshold(IntArray(256).apply { this[240] = 1000 }))
        assertEquals(128, ScanGeometry.binaryThreshold(IntArray(256)))
        assertEquals(48, ScanGeometry.binaryThreshold(IntArray(256).apply { this[0] = 100; this[250] = 1000 }))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `arbitrary rotation is rejected`() { ScanGeometry.normalizedRotation(45) }
}
