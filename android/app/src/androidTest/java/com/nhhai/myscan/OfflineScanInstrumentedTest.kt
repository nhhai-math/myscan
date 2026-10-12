package com.nhhai.myscan

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.view.View
import androidx.exifinterface.media.ExifInterface
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nhhai.myscan.data.ColorMode
import com.nhhai.myscan.data.EditSettings
import com.nhhai.myscan.data.PdfPaper
import com.nhhai.myscan.data.ScanPoint
import com.nhhai.myscan.data.ScanRepository
import com.nhhai.myscan.image.ScanImageProcessor
import com.nhhai.myscan.image.ScanEditorView
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlin.math.abs
import kotlin.math.min

/** Exercises Android's real bitmap, EXIF, private file storage and PDF implementations. */
@RunWith(AndroidJUnit4::class)
class OfflineScanInstrumentedTest {
    private lateinit var temporary: File
    private lateinit var context: Context
    private lateinit var repository: ScanRepository

    @Before fun createIsolatedLibrary() {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        temporary = File(target.cacheDir, "instrumented-scan-${UUID.randomUUID()}")
        assertTrue(temporary.mkdirs())
        context = object : ContextWrapper(target) {
            override fun getFilesDir() = File(temporary, "files").apply { mkdirs() }
            override fun getCacheDir() = File(temporary, "cache").apply { mkdirs() }
        }
        repository = ScanRepository(context)
    }

    @After fun removeIsolatedLibrary() {
        if (::temporary.isInitialized) assertTrue(temporary.deleteRecursively())
    }

    @Test fun exifImportBecomesUprightAndDoesNotChangeSourcePhoto() {
        val source = writeQuadrants("portrait-camera.jpg", 320, 180)
        ExifInterface(source).apply {
            setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
            saveAttributes()
        }
        val sourceBytes = source.readBytes()
        val document = repository.createDocument("Ảnh chụp điện thoại")
        val imported = repository.addPage(document.id, Uri.fromFile(source))
        val page = imported.pages.single()
        assertEquals(180, page.originalWidth)
        assertEquals(320, page.originalHeight)
        assertEquals(page.originalWidth, page.width)
        assertEquals(page.originalHeight, page.height)
        assertArrayEquals(sourceBytes, source.readBytes())
        val original = repository.originalFile(document.id, page.id)
        val originalBitmap = BitmapFactory.decodeFile(original.absolutePath)
        try {
            assertCornerColors(originalBitmap, listOf(Color.YELLOW, Color.RED, Color.GREEN, Color.BLUE), 12)
        } finally { originalBitmap.recycle() }
        val canonicalOrientation = ExifInterface(original).getAttributeInt(
            ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_UNDEFINED)
        // JPEG encoding may remove the tag; absent orientation and NORMAL both mean upright pixels.
        assertTrue(canonicalOrientation == ExifInterface.ORIENTATION_UNDEFINED ||
            canonicalOrientation == ExifInterface.ORIENTATION_NORMAL)
        assertArrayEquals(original.readBytes(), repository.imageFile(document.id, page.id).readBytes())
    }

    @Test fun loaderHonorsAllExifOrientationsAndLimitsImageSize() {
        val source = writeQuadrants("orientations.jpg", 320, 180)
        val cases = listOf(
            ExifInterface.ORIENTATION_NORMAL to listOf(Color.RED, Color.GREEN, Color.BLUE, Color.YELLOW),
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL to listOf(Color.GREEN, Color.RED, Color.YELLOW, Color.BLUE),
            ExifInterface.ORIENTATION_ROTATE_180 to listOf(Color.BLUE, Color.YELLOW, Color.RED, Color.GREEN),
            ExifInterface.ORIENTATION_FLIP_VERTICAL to listOf(Color.YELLOW, Color.BLUE, Color.GREEN, Color.RED),
            ExifInterface.ORIENTATION_TRANSPOSE to listOf(Color.RED, Color.YELLOW, Color.BLUE, Color.GREEN),
            ExifInterface.ORIENTATION_ROTATE_90 to listOf(Color.YELLOW, Color.RED, Color.GREEN, Color.BLUE),
            ExifInterface.ORIENTATION_TRANSVERSE to listOf(Color.BLUE, Color.GREEN, Color.RED, Color.YELLOW),
            ExifInterface.ORIENTATION_ROTATE_270 to listOf(Color.GREEN, Color.BLUE, Color.YELLOW, Color.RED),
        )
        cases.forEach { (orientation, colors) ->
            ExifInterface(source).apply {
                setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString())
                saveAttributes()
            }
            val bitmap = ScanImageProcessor.loadOriented(source, 80)
            try {
                val swapsAxes = orientation in setOf(ExifInterface.ORIENTATION_TRANSPOSE,
                    ExifInterface.ORIENTATION_ROTATE_90, ExifInterface.ORIENTATION_TRANSVERSE,
                    ExifInterface.ORIENTATION_ROTATE_270)
                assertEquals("EXIF $orientation width", if (swapsAxes) 45 else 80, bitmap.width)
                assertEquals("EXIF $orientation height", if (swapsAxes) 80 else 45, bitmap.height)
                assertCornerColors(bitmap, colors, 12)
            } finally { bitmap.recycle() }
        }
    }

    @Test fun perspectiveAndEveryRotationPreserveCornerContent() {
        val source = quadrants(320, 180)
        val settings = EditSettings(corners = perspectiveCorners())
        val expected = mapOf(
            0 to listOf(Color.RED, Color.GREEN, Color.BLUE, Color.YELLOW),
            90 to listOf(Color.YELLOW, Color.RED, Color.GREEN, Color.BLUE),
            180 to listOf(Color.BLUE, Color.YELLOW, Color.RED, Color.GREEN),
            270 to listOf(Color.GREEN, Color.BLUE, Color.YELLOW, Color.RED),
        )
        try {
            expected.forEach { (rotation, colors) ->
                val processed = ScanImageProcessor.process(source, settings.copy(rotation = rotation))
                try {
                    assertCornerColors(processed, colors, 3)
                    assertEquals(rotation == 90 || rotation == 270, processed.height > processed.width)
                    // A wrongly translated matrix can produce white or transparent strips after rotation.
                    for (x in 1..8) for (y in 1..8) {
                        val pixel = processed.getPixel(processed.width * x / 10, processed.height * y / 10)
                        assertEquals(255, Color.alpha(pixel))
                        assertFalse("Blank region at rotation $rotation", pixel == Color.WHITE)
                    }
                } finally { processed.recycle() }
            }
            assertCornerColors(source, expected.getValue(0), 0)
            assertFalse(source.isRecycled)
        } finally { source.recycle() }
    }

    @Test fun grayscaleAndBlackWhiteUseRealFilteredPixels() {
        val source = quadrants(320, 180)
        try {
            val grayscale = ScanImageProcessor.process(source, EditSettings(rotation = 90,
                corners = perspectiveCorners(), mode = ColorMode.GRAYSCALE))
            try {
                val levels = cornerPixels(grayscale).map {
                    assertTrue(abs(Color.red(it) - Color.green(it)) <= 1)
                    assertTrue(abs(Color.green(it) - Color.blue(it)) <= 1)
                    Color.red(it)
                }
                assertTrue("Yellow should remain lighter than green", levels[0] > levels[2])
                assertTrue("Green should remain lighter than red", levels[2] > levels[1])
                assertTrue("Red should remain lighter than blue", levels[1] > levels[3])
            } finally { grayscale.recycle() }
            val binary = ScanImageProcessor.process(source, EditSettings(mode = ColorMode.BLACK_WHITE))
            try {
                val pixels = cornerPixels(binary)
                assertTrue(pixels.all { it == Color.WHITE || it == Color.BLACK })
                assertTrue(pixels.contains(Color.WHITE))
                assertTrue(pixels.contains(Color.BLACK))
            } finally { binary.recycle() }
        } finally { source.recycle() }
    }

    @Test fun editedPageKeepsOriginalAndRestoresSettingsWhenLibraryReopens() {
        val document = repository.createDocument("Bài tập Toán")
        val imported = repository.addPage(document.id, Uri.fromFile(writeQuadrants("page.jpg", 320, 180)))
        val page = imported.pages.single()
        val original = repository.originalFile(document.id, page.id)
        val originalBytes = original.readBytes()
        val settings = EditSettings(rotation = 90, corners = perspectiveCorners(),
            mode = ColorMode.GRAYSCALE, brightness = .12f, contrast = 1.3f)
        val source = ScanImageProcessor.loadOriented(original)
        val processed = ScanImageProcessor.process(source, settings)
        try {
            val saved = repository.saveEditedPage(document.id, page.id, processed, settings).pages.single()
            assertEquals(processed.width, saved.width)
            assertEquals(processed.height, saved.height)
            assertTrue(saved.updatedAt > page.updatedAt)
        } finally { processed.recycle(); source.recycle() }
        assertArrayEquals(originalBytes, original.readBytes())
        assertFalse(originalBytes.contentEquals(repository.imageFile(document.id, page.id).readBytes()))
        val restored = ScanRepository(context).getDocument(document.id)!!.pages.single()
        assertEquals(settings, restored.edit)
        assertEquals(320, restored.originalWidth)
        assertEquals(180, restored.originalHeight)
        val editedBitmap = BitmapFactory.decodeFile(repository.imageFile(document.id, page.id).absolutePath)
        try {
            val center = editedBitmap.getPixel(editedBitmap.width / 4, editedBitmap.height / 4)
            assertTrue(abs(Color.red(center) - Color.green(center)) <= 2)
            assertTrue(abs(Color.green(center) - Color.blue(center)) <= 2)
        } finally { editedBitmap.recycle() }
    }

    @Test fun reorderPersistsAndBothPdfExportsContainPagesInOrder() {
        val document = repository.createDocument("Phiếu điểm / lớp 12A1")
        val colors = listOf(Color.RED, Color.GREEN, Color.BLUE)
        colors.forEachIndexed { index, color ->
            repository.addPage(document.id, Uri.fromFile(writeSolid("page-$index.jpg", color, 300, 180)))
        }
        val pages = repository.getDocument(document.id)!!.pages
        val order = listOf(pages[2].id, pages[0].id, pages[1].id)
        repository.reorderPages(document.id, order)
        val reopened = ScanRepository(context)
        assertEquals(order, reopened.getDocument(document.id)!!.pages.map { it.id })
        val expectedColors = listOf(Color.BLUE, Color.RED, Color.GREEN)
        val exported = reopened.exportPdf(document.id)
        assertTrue(exported.name.endsWith(".pdf"))
        assertFalse(exported.name.contains('/'))
        assertPdfPages(exported, expectedColors, 842, 595)
        val written = File(temporary, "user-selected-output.pdf")
        written.outputStream().use { reopened.writePdf(document.id, it, PdfPaper.IMAGE_RATIO) }
        assertPdfPages(written, expectedColors, 842, 505)
    }

    @Test fun rejectedEditsReordersAndImageImportsKeepLibraryAndImagesIntact() {
        val document = repository.createDocument("Cần giữ nguyên")
        val imported = repository.addPage(document.id, Uri.fromFile(writeSolid("page.jpg", Color.CYAN, 160, 200)))
        val page = imported.pages.single()
        val metadata = metadataFile()
        val beforeMetadata = metadata.readBytes()
        val image = repository.imageFile(document.id, page.id)
        val beforeImage = image.readBytes()
        val mutableCorners = EditSettings().corners.toMutableList()
        val invalid = EditSettings(corners = mutableCorners)
        mutableCorners[1] = ScanPoint(.1f, .9f)
        val bitmap = Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888)
        try {
            expectFailure<IllegalArgumentException> { repository.saveEditedPage(document.id, page.id, bitmap, invalid) }
        } finally { bitmap.recycle() }
        expectFailure<IllegalArgumentException> { repository.reorderPages(document.id, listOf(page.id, page.id)) }
        val notImage = File(temporary, "broken.jpg").apply { writeText("This is not an image") }
        expectFailure<IllegalArgumentException> { repository.addPage(document.id, Uri.fromFile(notImage)) }
        assertArrayEquals(beforeMetadata, metadata.readBytes())
        assertArrayEquals(beforeImage, image.readBytes())
        assertEquals(1, repository.getDocument(document.id)!!.pages.size)
        assertEquals(1, File(context.filesDir, "myscan/documents/${document.id}").listFiles()!!.size)
    }

    @Test fun corruptedMetadataDoesNotEraseIndexOrOriginalPhotos() {
        val document = repository.createDocument("Hồ sơ cần bảo toàn")
        val imported = repository.addPage(document.id, Uri.fromFile(writeSolid("page.jpg", Color.BLUE, 160, 200)))
        val original = repository.originalFile(document.id, imported.pages.single().id)
        val originalBytes = original.readBytes()
        val broken = "{\"version\":1,\"documents\":[ malformed index with user data"
        metadataFile().writeText(broken)
        expectFailure<IOException> { ScanRepository(context) }
        expectFailure<IOException> { repository.createDocument("Không được ghi đè") }
        assertEquals(broken, metadataFile().readText())
        assertArrayEquals(originalBytes, original.readBytes())
    }

    @Test fun mainActivityLaunchesWithoutInternetPermission() {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        @Suppress("DEPRECATION")
        val permissions = target.packageManager.getPackageInfo(target.packageName,
            PackageManager.GET_PERMISSIONS).requestedPermissions.orEmpty()
        assertFalse(permissions.contains("android.permission.INTERNET"))
        val intent = Intent().setClassName(target.packageName, "com.nhhai.myscan.MainActivity")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<Activity>(intent).use { scenario ->
            scenario.onActivity { activity ->
                assertFalse(activity.isFinishing)
                assertNotNull(activity.findViewById<android.view.View>(android.R.id.content))
            }
        }
    }

    @Test fun editorViewDrawsCropHandlesAndPreviewInRealScreenCoordinates() {
        var failure: Throwable? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            // Re-throw on the JUnit thread so a renderer regression fails this test without killing the app process.
            try {
                val view = ScanEditorView(context)
                view.measure(View.MeasureSpec.makeMeasureSpec(320, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(480, View.MeasureSpec.EXACTLY))
                view.layout(0, 0, 320, 480)
                val source = quadrants(320, 180)
                val rendered = Bitmap.createBitmap(320, 480, Bitmap.Config.ARGB_8888)
                try {
                    val expected = mapOf(
                        0 to listOf(Color.RED, Color.GREEN, Color.BLUE, Color.YELLOW),
                        90 to listOf(Color.YELLOW, Color.RED, Color.GREEN, Color.BLUE),
                        180 to listOf(Color.BLUE, Color.YELLOW, Color.RED, Color.GREEN),
                        270 to listOf(Color.GREEN, Color.BLUE, Color.YELLOW, Color.RED),
                    )
                    val full = EditSettings().corners
                    for (corners in listOf(full, perspectiveCorners())) {
                        expected.forEach { (rotation, colors) ->
                            rendered.eraseColor(Color.TRANSPARENT)
                            view.setSource(source, rotation, corners)
                            view.draw(Canvas(rendered))
                            assertEquals(Color.rgb(20, 42, 44), rendered.getPixel(0, 0))
                            val (left, top, width, height) = editorImageBounds(source, rotation, view)
                            listOf(.25f to .25f, .75f to .25f, .75f to .75f, .25f to .75f)
                                .zip(colors).forEachIndexed { index, (point, color) ->
                                    assertColorClose("Editor rotation $rotation corner $index", color,
                                        rendered.getPixel((left + width * point.first).toInt(),
                                            (top + height * point.second).toInt()), 3)
                                }
                            // The four touch handles should be visible in the screen bitmap; their centers are white.
                            com.nhhai.myscan.image.ScanGeometry.displayCorners(corners, rotation).forEach { point ->
                                val x = (left + width * point.x).toInt()
                                val y = (top + height * point.y).toInt()
                                assertColorClose("Editor crop handle", Color.WHITE, rendered.getPixel(x, y), 3)
                            }
                        }
                    }
                    val preview = ScanImageProcessor.process(source, EditSettings(rotation = 90,
                        corners = perspectiveCorners(), mode = ColorMode.GRAYSCALE))
                    try {
                        view.setPreview(preview)
                        rendered.eraseColor(Color.TRANSPARENT)
                        view.draw(Canvas(rendered))
                        val center = rendered.getPixel(view.width / 2, view.height / 2)
                        assertEquals(255, Color.alpha(center))
                        assertTrue(abs(Color.red(center) - Color.green(center)) <= 1)
                        assertTrue(abs(Color.green(center) - Color.blue(center)) <= 1)
                        assertFalse(center == Color.rgb(20, 42, 44))
                    } finally { view.setPreview(null); preview.recycle() }
                } finally { rendered.recycle(); source.recycle() }
            } catch (error: Throwable) {
                failure = error
            }
        }
        failure?.let { throw it }
    }

    private fun editorImageBounds(source: Bitmap, rotation: Int, view: View): List<Float> {
        val sideways = rotation == 90 || rotation == 270
        val width = if (sideways) source.height else source.width
        val height = if (sideways) source.width else source.height
        val padding = 48f * view.resources.displayMetrics.density
        val scale = min((view.width - padding) / width, (view.height - padding) / height)
        val fittedWidth = width * scale
        val fittedHeight = height * scale
        return listOf((view.width - fittedWidth) / 2f, (view.height - fittedHeight) / 2f,
            fittedWidth, fittedHeight)
    }

    private fun metadataFile() = File(context.filesDir, "myscan/metadata.json")

    private fun perspectiveCorners() = listOf(ScanPoint(.1f, .08f), ScanPoint(.92f, .14f),
        ScanPoint(.86f, .91f), ScanPoint(.14f, .84f))

    private fun quadrants(width: Int, height: Int): Bitmap =
        Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply {
            density = Bitmap.DENSITY_NONE
            val canvas = Canvas(this)
            val paint = Paint()
            paint.color = Color.RED
            canvas.drawRect(0f, 0f, width / 2f, height / 2f, paint)
            paint.color = Color.GREEN
            canvas.drawRect(width / 2f, 0f, width.toFloat(), height / 2f, paint)
            paint.color = Color.BLUE
            canvas.drawRect(width / 2f, height / 2f, width.toFloat(), height.toFloat(), paint)
            paint.color = Color.YELLOW
            canvas.drawRect(0f, height / 2f, width / 2f, height.toFloat(), paint)
        }

    private fun writeQuadrants(name: String, width: Int, height: Int): File {
        val bitmap = quadrants(width, height)
        return writeBitmap(name, bitmap)
    }

    private fun writeSolid(name: String, color: Int, width: Int, height: Int): File {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(color)
        return writeBitmap(name, bitmap)
    }

    private fun writeBitmap(name: String, bitmap: Bitmap): File {
        val file = File(temporary, name)
        try {
            file.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 100, it)) }
            return file
        } finally { bitmap.recycle() }
    }

    private fun cornerPixels(bitmap: Bitmap): List<Int> = listOf(
        bitmap.getPixel(bitmap.width / 8, bitmap.height / 8),
        bitmap.getPixel(bitmap.width * 7 / 8, bitmap.height / 8),
        bitmap.getPixel(bitmap.width * 7 / 8, bitmap.height * 7 / 8),
        bitmap.getPixel(bitmap.width / 8, bitmap.height * 7 / 8),
    )

    private fun assertCornerColors(bitmap: Bitmap, expected: List<Int>, tolerance: Int) {
        cornerPixels(bitmap).zip(expected).forEachIndexed { index, (actual, wanted) ->
            assertColorClose("Corner $index", wanted, actual, tolerance)
        }
    }

    private fun assertColorClose(message: String, expected: Int, actual: Int, tolerance: Int) {
        assertTrue("$message red: ${Color.red(actual)}", abs(Color.red(expected) - Color.red(actual)) <= tolerance)
        assertTrue("$message green: ${Color.green(actual)}", abs(Color.green(expected) - Color.green(actual)) <= tolerance)
        assertTrue("$message blue: ${Color.blue(actual)}", abs(Color.blue(expected) - Color.blue(actual)) <= tolerance)
        assertEquals("$message alpha", 255, Color.alpha(actual))
    }

    private fun assertPdfPages(file: File, expectedColors: List<Int>, width: Int, height: Int) {
        ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
            PdfRenderer(descriptor).use { renderer ->
                assertEquals(expectedColors.size, renderer.pageCount)
                expectedColors.forEachIndexed { index, color ->
                    renderer.openPage(index).use { page ->
                        assertEquals(width, page.width)
                        assertEquals(height, page.height)
                        val rendered = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
                        try {
                            page.render(rendered, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            assertColorClose("PDF page ${index + 1}", color,
                                rendered.getPixel(page.width / 2, page.height / 2), 12)
                        } finally { rendered.recycle() }
                    }
                }
            }
        }
    }

    private inline fun <reified T : Throwable> expectFailure(block: () -> Unit) {
        try {
            block()
            fail("Expected ${T::class.java.simpleName}")
        } catch (error: Throwable) {
            if (error !is T) throw error
        }
    }
}
