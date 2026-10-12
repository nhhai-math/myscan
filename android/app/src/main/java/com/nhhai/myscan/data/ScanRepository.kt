package com.nhhai.myscan.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.pdf.PdfDocument
import android.net.Uri
import android.util.AtomicFile
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** App-private, offline storage. Run image import, edits and PDF export on a worker thread. */
class ScanRepository(context: Context) {
    private val appContext = context.applicationContext
    private val root = File(context.filesDir, "myscan")
    private val documentsDirectory = File(root, "documents")
    private val exportDirectory = File(context.cacheDir, "myscan-exports")
    private val metadata = AtomicFile(File(root, "metadata.json"))
    private val lock = locks.getOrPut(root.absolutePath) { Any() }

    init {
        synchronized(lock) {
            ensureDirectory(root)
            ensureDirectory(documentsDirectory)
            // Validate before any operation; never replace a corrupt library with an empty one.
            readDocuments()
        }
    }

    fun listDocuments(): List<ScanDocument> = synchronized(lock) {
        readDocuments().sortedByDescending { it.updatedAt }
    }

    fun getDocument(id: String): ScanDocument? = synchronized(lock) {
        requireScanId(id)
        readDocuments().find { it.id == id }
    }

    fun createDocument(title: String): ScanDocument = synchronized(lock) {
        val documents = readDocuments()
        val now = System.currentTimeMillis()
        val document = ScanDocument(UUID.randomUUID().toString(), cleanTitle(title), now, now)
        saveDocuments(documents + document)
        document
    }

    fun renameDocument(id: String, title: String): ScanDocument = synchronized(lock) {
        val documents = readDocuments()
        val document = findDocument(documents, id)
        val updated = document.copy(title = cleanTitle(title), updatedAt = nextTimestamp(document.updatedAt))
        saveDocuments(replaceDocument(documents, updated))
        updated
    }

    fun deleteDocument(id: String) = synchronized(lock) {
        val documents = readDocuments()
        findDocument(documents, id)
        saveDocuments(documents.filterNot { it.id == id })
        val imagesRemoved = File(documentsDirectory, id).deleteRecursively()
        val exportsRemoved = File(exportDirectory, id).deleteRecursively()
        if (!imagesRemoved || !exportsRemoved) {
            throw IOException("Đã xóa tài liệu khỏi thư viện nhưng không xóa hết tệp ảnh. Hãy kiểm tra dung lượng và quyền lưu trữ.")
        }
    }

    /** Copies the source and removes EXIF orientation by rendering an upright, white-backed JPEG. */
    fun addPage(documentId: String, source: Uri): ScanDocument = synchronized(lock) {
        val documents = readDocuments()
        val document = findDocument(documents, documentId)
        require(document.pages.size < MAX_DOCUMENT_PAGES) { "Mỗi tài liệu chỉ có tối đa $MAX_DOCUMENT_PAGES trang." }
        val pageId = UUID.randomUUID().toString()
        val pageDirectory = File(File(documentsDirectory, documentId), pageId)
        ensureDirectory(pageDirectory)
        val importFile = File(pageDirectory, "import.tmp")
        var normalized: Bitmap? = null
        try {
            appContext.contentResolver.openInputStream(source)?.use { input ->
                FileOutputStream(importFile).use { output ->
                    val buffer = ByteArray(32 * 1024)
                    var total = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        require(total <= MAX_IMPORT_BYTES) { "Ảnh quá lớn; hãy chọn ảnh nhỏ hơn 32 MB." }
                        output.write(buffer, 0, count)
                    }
                    require(total > 0) { "Tệp ảnh trống." }
                }
            } ?: throw IOException("Không mở được ảnh. Hãy chọn lại ảnh từ điện thoại.")
            normalized = normalizeImage(importFile)
            val original = File(pageDirectory, ORIGINAL_FILENAME)
            writeBitmap(original, normalized)
            original.copyTo(File(pageDirectory, IMAGE_FILENAME))
            val now = nextTimestamp(document.updatedAt)
            val page = ScanPage(pageId, normalized.width, normalized.height, normalized.width, normalized.height, now, now)
            val updated = document.copy(updatedAt = now, pages = document.pages + page)
            saveDocuments(replaceDocument(documents, updated))
            updated
        } catch (error: Throwable) {
            pageDirectory.deleteRecursively()
            throw error
        } finally {
            normalized?.recycle()
            importFile.delete()
        }
    }

    /** The caller owns bitmap. Editing never writes the original image. */
    fun saveEditedPage(documentId: String, pageId: String, bitmap: Bitmap, settings: EditSettings): ScanDocument = synchronized(lock) {
        settings.validate()
        require(!bitmap.isRecycled && bitmap.width > 0 && bitmap.height > 0) { "Ảnh chỉnh sửa không hợp lệ." }
        val documents = readDocuments()
        val document = findDocument(documents, documentId)
        val page = findPage(document, pageId)
        val destination = checkedImageFile(documentId, pageId, IMAGE_FILENAME)
        val temporary = File(destination.parentFile, "edit-${UUID.randomUUID()}.tmp")
        val previous = File(destination.parentFile, "previous-${UUID.randomUUID()}.tmp")
        val flattened = flattenAndLimit(bitmap)
        var imageCommitted = false
        try {
            writeBitmap(temporary, flattened)
            destination.copyTo(previous)
            replaceFile(destination, temporary)
            imageCommitted = true
            val now = nextTimestamp(max(document.updatedAt, page.updatedAt))
            val updatedPage = page.copy(
                width = flattened.width, height = flattened.height, updatedAt = now,
                edit = settings.copy(corners = settings.corners.toList()),
            )
            val updated = document.copy(updatedAt = now, pages = document.pages.map { if (it.id == pageId) updatedPage else it })
            saveDocuments(replaceDocument(documents, updated))
            updated
        } catch (error: Throwable) {
            if (imageCommitted) {
                try {
                    replaceFile(destination, previous)
                } catch (rollbackError: Throwable) {
                    error.addSuppressed(rollbackError)
                }
            }
            throw error
        } finally {
            flattened.recycle()
            temporary.delete()
            previous.delete()
        }
    }

    fun reorderPages(documentId: String, pageIds: List<String>): ScanDocument = synchronized(lock) {
        val documents = readDocuments()
        val document = findDocument(documents, documentId)
        require(pageIds.size == document.pages.size && pageIds.toSet() == document.pages.map { it.id }.toSet()) {
            "Thứ tự trang phải chứa đúng mỗi trang một lần."
        }
        val pages = document.pages.associateBy { it.id }
        val updated = document.copy(updatedAt = nextTimestamp(document.updatedAt), pages = pageIds.map { pages.getValue(it) })
        saveDocuments(replaceDocument(documents, updated))
        updated
    }

    fun deletePage(documentId: String, pageId: String): ScanDocument = synchronized(lock) {
        val documents = readDocuments()
        val document = findDocument(documents, documentId)
        findPage(document, pageId)
        val updated = document.copy(updatedAt = nextTimestamp(document.updatedAt), pages = document.pages.filterNot { it.id == pageId })
        saveDocuments(replaceDocument(documents, updated))
        if (!File(File(documentsDirectory, documentId), pageId).deleteRecursively()) {
            throw IOException("Đã xóa trang khỏi tài liệu nhưng không xóa hết tệp ảnh. Hãy kiểm tra dung lượng lưu trữ.")
        }
        // Previous shared PDFs must not retain a page that the user deleted.
        File(exportDirectory, documentId).deleteRecursively()
        updated
    }

    fun originalFile(documentId: String, pageId: String): File = synchronized(lock) {
        findPage(findDocument(readDocuments(), documentId), pageId)
        checkedImageFile(documentId, pageId, ORIGINAL_FILENAME)
    }

    fun imageFile(documentId: String, pageId: String): File = synchronized(lock) {
        findPage(findDocument(readDocuments(), documentId), pageId)
        checkedImageFile(documentId, pageId, IMAGE_FILENAME)
    }

    fun exportPdf(documentId: String, paper: PdfPaper = PdfPaper.A4): File = synchronized(lock) {
        val document = findDocument(readDocuments(), documentId)
        val directory = File(exportDirectory, documentId)
        ensureDirectory(directory)
        val safeTitle = document.title.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_")
            .trim(' ', '.').take(100).ifBlank { "Tài liệu scan" }
        val target = File(directory, "$safeTitle.pdf")
        atomicWrite(target) { output -> writeDocumentPdf(document, output, paper) }
        target
    }

    /** Does not close out; suitable for a Storage Access Framework destination chosen by the user. */
    fun writePdf(documentId: String, out: OutputStream, paper: PdfPaper = PdfPaper.A4) = synchronized(lock) {
        writeDocumentPdf(findDocument(readDocuments(), documentId), out, paper)
    }

    private fun writeDocumentPdf(document: ScanDocument, out: OutputStream, paper: PdfPaper) {
        require(document.pages.isNotEmpty()) { "Thêm ít nhất một trang trước khi xuất PDF." }
        val pdf = PdfDocument()
        try {
            val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
            document.pages.forEachIndexed { index, scanPage ->
                val file = checkedImageFile(document.id, scanPage.id, IMAGE_FILENAME)
                val bitmap = BitmapFactory.decodeFile(file.absolutePath)
                    ?: throw IOException("Không đọc được trang ${index + 1}. Hãy mở lại và kiểm tra ảnh.")
                try {
                    val dimensions = PdfLayout.dimensions(bitmap.width, bitmap.height, paper)
                    val page = pdf.startPage(PdfDocument.PageInfo.Builder(dimensions.first, dimensions.second, index + 1).create())
                    try {
                        page.canvas.drawColor(Color.WHITE)
                        val margin = if (paper == PdfPaper.A4) 16f else 0f
                        val ratio = min((dimensions.first - 2 * margin) / bitmap.width, (dimensions.second - 2 * margin) / bitmap.height)
                        val width = bitmap.width * ratio
                        val height = bitmap.height * ratio
                        val left = (dimensions.first - width) / 2f
                        val top = (dimensions.second - height) / 2f
                        page.canvas.drawBitmap(bitmap, null, RectF(left, top, left + width, top + height), paint)
                    } finally {
                        pdf.finishPage(page)
                    }
                } finally {
                    bitmap.recycle()
                }
            }
            pdf.writeTo(out)
        } finally {
            pdf.close()
        }
    }

    private fun readDocuments(): List<ScanDocument> {
        try {
            val file = metadata.baseFile
            require(file.length() <= MAX_METADATA_BYTES) { "Tệp thư viện quá lớn." }
            val text = metadata.openRead().bufferedReader(Charsets.UTF_8).use { it.readText() }
            return MetadataCodec.decode(text)
        } catch (error: FileNotFoundException) {
            if (!metadata.baseFile.exists() && !File(metadata.baseFile.path + ".bak").exists() &&
                documentsDirectory.listFiles()?.isEmpty() == true) {
                return emptyList()
            }
            throw IOException("Không tìm thấy chỉ mục thư viện nhưng ảnh vẫn còn. Giữ nguyên dữ liệu và khôi phục metadata.json từ bản sao lưu.", error)
        } catch (error: Exception) {
            throw IOException("Không đọc được thư viện. Dữ liệu hiện có được giữ nguyên; hãy sao lưu thư mục myscan và khôi phục metadata.json hợp lệ.", error)
        }
    }

    private fun saveDocuments(documents: List<ScanDocument>) {
        val bytes = MetadataCodec.encode(documents).toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_METADATA_BYTES) { "Thư viện quá lớn. Hãy xuất và xóa bớt tài liệu." }
        atomicWrite(metadata.baseFile) { it.write(bytes) }
    }

    private fun checkedImageFile(documentId: String, pageId: String, filename: String): File {
        requireScanId(documentId)
        requireScanId(pageId)
        val file = File(File(File(documentsDirectory, documentId), pageId), filename)
        if (!file.isFile || file.length() == 0L) {
            throw IOException("Thiếu ảnh của trang. Hãy khôi phục cả thư mục myscan từ bản sao lưu.")
        }
        return file
    }

    private fun findDocument(documents: List<ScanDocument>, id: String): ScanDocument {
        requireScanId(id)
        return documents.find { it.id == id } ?: throw IllegalArgumentException("Tài liệu không còn trong thư viện.")
    }

    private fun findPage(document: ScanDocument, pageId: String): ScanPage {
        requireScanId(pageId)
        return document.pages.find { it.id == pageId } ?: throw IllegalArgumentException("Trang không còn trong tài liệu.")
    }

    private fun replaceDocument(documents: List<ScanDocument>, updated: ScanDocument) =
        documents.map { if (it.id == updated.id) updated else it }

    private fun cleanTitle(title: String): String = title.trim().also {
        require(it.isNotBlank() && it.length <= MAX_DOCUMENT_TITLE_LENGTH) {
            "Tên tài liệu cần có từ 1 đến $MAX_DOCUMENT_TITLE_LENGTH ký tự."
        }
    }

    private fun normalizeImage(file: File): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Ảnh không đọc được. Hãy chọn JPEG, PNG, WebP hoặc ảnh được Android hỗ trợ." }
        require(bounds.outWidth.toLong() * bounds.outHeight <= MAX_SOURCE_PIXELS) {
            "Ảnh có độ phân giải quá lớn. Hãy giảm kích thước trước khi nhập."
        }
        var sample = 1
        val sourceEdge = max(bounds.outWidth, bounds.outHeight)
        while (sourceEdge / (sample * 2) >= MAX_IMAGE_EDGE) sample *= 2
        val decoded = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
            if (sourceEdge / sample > MAX_IMAGE_EDGE) {
                inScaled = true
                inDensity = sourceEdge
                inTargetDensity = MAX_IMAGE_EDGE * sample
            }
        }) ?: throw IOException("Không đọc được nội dung ảnh. Hãy chọn lại tệp ảnh.")
        var owned: Bitmap? = decoded
        try {
            val orientation = ExifInterface(file).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            val matrix = orientationMatrix(orientation)
            if (!matrix.isIdentity) {
                val oriented = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
                if (oriented !== decoded) {
                    decoded.recycle()
                    owned = oriented
                }
            }
            val upright = requireNotNull(owned)
            if (!upright.hasAlpha() && max(upright.width, upright.height) <= MAX_IMAGE_EDGE) {
                owned = null // Transfer ownership; avoid an extra full-resolution JPEG bitmap.
                return upright
            }
            return flattenAndLimit(upright)
        } finally {
            owned?.recycle()
        }
    }

    private fun flattenAndLimit(source: Bitmap): Bitmap {
        val ratio = min(1f, MAX_IMAGE_EDGE.toFloat() / max(source.width, source.height))
        val width = max(1, (source.width * ratio).roundToInt())
        val height = max(1, (source.height * ratio).roundToInt())
        return Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply {
            val canvas = Canvas(this)
            canvas.drawColor(Color.WHITE)
            canvas.drawBitmap(source, null, RectF(0f, 0f, width.toFloat(), height.toFloat()), Paint(Paint.FILTER_BITMAP_FLAG))
        }
    }

    private fun writeBitmap(file: File, bitmap: Bitmap) {
        FileOutputStream(file).use { output ->
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 94, output)) throw IOException("Không ghi được ảnh scan.")
            output.fd.sync()
        }
    }

    private fun replaceFile(destination: File, source: File) {
        atomicWrite(destination) { output -> source.inputStream().use { it.copyTo(output) } }
    }

    private fun atomicWrite(file: File, write: (FileOutputStream) -> Unit) {
        val atomic = AtomicFile(file)
        val output = atomic.startWrite()
        try {
            write(output)
            atomic.finishWrite(output)
        } catch (error: Throwable) {
            atomic.failWrite(output)
            throw error
        }
    }

    private fun ensureDirectory(directory: File) {
        if (!directory.isDirectory && !directory.mkdirs()) throw IOException("Không tạo được thư mục lưu trữ. Hãy kiểm tra dung lượng điện thoại.")
    }

    private fun nextTimestamp(previous: Long): Long = max(System.currentTimeMillis(), previous + 1)

    companion object {
        private val locks = ConcurrentHashMap<String, Any>()
        private const val MAX_IMPORT_BYTES = 32L * 1024 * 1024
        private const val MAX_SOURCE_PIXELS = 100_000_000L
        private const val MAX_METADATA_BYTES = 32L * 1024 * 1024
        private const val ORIGINAL_FILENAME = "original.jpg"
        private const val IMAGE_FILENAME = "image.jpg"

        private fun orientationMatrix(orientation: Int) = Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
                ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(270f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(270f)
            }
        }

    }
}
