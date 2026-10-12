package com.nhhai.myscan

import android.app.AlertDialog
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.nhhai.myscan.data.PdfPaper
import com.nhhai.myscan.data.ScanDocument
import com.nhhai.myscan.data.ScanPage
import com.nhhai.myscan.data.ScanRepository
import com.nhhai.myscan.ui.CameraActivity
import com.nhhai.myscan.ui.EditActivity
import com.nhhai.myscan.ui.Ui
import com.nhhai.myscan.ui.Ui.dp
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var root: LinearLayout
    private lateinit var content: FrameLayout
    private lateinit var actions: LinearLayout
    private lateinit var status: TextView
    private var repository: ScanRepository? = null
    private var documents: List<ScanDocument> = emptyList()
    private var documentId: String? = null
    private var pageId: String? = null
    private var pendingCameraDocument: String? = null
    private var pendingImportDocument: String? = null
    private var pendingExportDocument: String? = null
    private var pendingExportPaper = PdfPaper.A4
    private var query = ""
    private var busy = false
    private var alive = true
    private var showingOriginal = false
    private var refreshGeneration = 0
    private val dateFormat = SimpleDateFormat("dd/MM/yyyy · HH:mm", Locale("vi", "VN"))
    private val bitmaps = mutableListOf<Bitmap>()
    private val pendingWork = ArrayDeque<() -> Unit>()

    private val camera = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val target = pendingCameraDocument
        pendingCameraDocument = null
        val photoPath = result.data?.getStringExtra("photoPath")
        if (result.resultCode != RESULT_OK || target == null || photoPath == null) return@registerForActivityResult
        val source = File(photoPath)
        val cameraRoot = File(cacheDir, "scan-camera").canonicalFile
        if (!source.canonicalFile.toPath().startsWith(cameraRoot.toPath())) {
            showError("Đường dẫn ảnh camera không hợp lệ.")
            return@registerForActivityResult
        }
        work("Đang lưu ảnh chụp…", {
            try { requireRepository().addPage(target, Uri.fromFile(source)) }
            finally { source.delete() }
        }) { document ->
            documentId = document.id
            pageId = document.pages.lastOrNull()?.id
            refresh()
            Toast.makeText(this, "Đã thêm trang · ảnh gốc được giữ lại", Toast.LENGTH_SHORT).show()
        }
    }

    private val gallery = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val target = pendingImportDocument
        pendingImportDocument = null
        if (uris.isEmpty() || target == null) return@registerForActivityResult
        if (uris.size > 20) { showError("Mỗi lần chọn tối đa 20 ảnh."); return@registerForActivityResult }
        work("Đang thêm ${uris.size} ảnh…", {
            var last = requireRepository().getDocument(target) ?: error("Không tìm thấy tài liệu.")
            val failures = mutableListOf<String>()
            var added = 0
            for ((index, uri) in uris.withIndex()) {
                try { last = requireRepository().addPage(target, uri); added++ }
                catch (error: Exception) { failures += "Ảnh ${index + 1}: ${error.message ?: "Không đọc được ảnh."}" }
            }
            Triple(last, added, failures)
        }) { (document, added, failures) ->
            documentId = document.id
            pageId = document.pages.lastOrNull()?.id
            refresh()
            if (failures.isNotEmpty()) showError("Đã thêm $added/${uris.size} ảnh.\n\n${failures.joinToString("\n")}")
            else Toast.makeText(this, "Đã thêm $added trang", Toast.LENGTH_SHORT).show()
        }
    }

    private val editor = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (it.resultCode == RESULT_OK) {
            showingOriginal = false
            Toast.makeText(this, "Đã lưu bản scan", Toast.LENGTH_SHORT).show()
        }
        refresh()
    }

    private val savePdf = registerForActivityResult(ActivityResultContracts.CreateDocument("application/pdf")) { uri ->
        val target = pendingExportDocument
        pendingExportDocument = null
        if (uri == null || target == null) return@registerForActivityResult
        val paper = pendingExportPaper
        work("Đang ghép tài liệu PDF…", {
            contentResolver.openOutputStream(uri)?.use { requireRepository().writePdf(target, it, paper) }
                ?: error("Không mở được nơi lưu PDF. Hãy chọn một thư mục khác.")
            uri
        }) { exported ->
            AlertDialog.Builder(this).setTitle("Tài liệu đã hoàn thiện")
                .setMessage("Đã lưu PDF với các trang theo thứ tự hiện tại.")
                .setPositiveButton("Mở PDF") { _, _ -> openPdf(exported) }
                .setNegativeButton("Xong", null).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        documentId = savedInstanceState?.getString("documentId")
        pageId = savedInstanceState?.getString("pageId")
        pendingCameraDocument = savedInstanceState?.getString("cameraDocument")
        pendingImportDocument = savedInstanceState?.getString("importDocument")
        pendingExportDocument = savedInstanceState?.getString("exportDocument")
        pendingExportPaper = savedInstanceState?.getString("exportPaper")?.let { runCatching { PdfPaper.valueOf(it) }.getOrNull() } ?: PdfPaper.A4
        query = savedInstanceState?.getString("query") ?: ""
        buildShell()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (busy) return
                if (documentId != null) { documentId = null; pageId = null; render() }
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })
        work("Đang mở thư viện…", { ScanRepository(applicationContext) }) { store ->
            repository = store
            refresh()
        }
    }

    override fun onResume() {
        super.onResume()
        if (repository != null && !busy) refresh()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("documentId", documentId)
        outState.putString("pageId", pageId)
        outState.putString("cameraDocument", pendingCameraDocument)
        outState.putString("importDocument", pendingImportDocument)
        outState.putString("exportDocument", pendingExportDocument)
        outState.putString("exportPaper", pendingExportPaper.name)
        outState.putString("query", query)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        alive = false
        pendingWork.clear()
        main.removeCallbacksAndMessages(null)
        worker.shutdown()
        releaseBitmaps()
        super.onDestroy()
    }

    private fun buildShell() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        root = Ui.column(this).apply { setBackgroundColor(Ui.background) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        val brandRow = Ui.row(this).apply { setPadding(dp(22), dp(17), dp(22), dp(17)) }
        brandRow.addView(Ui.text(this, "myscan.", 27f, Ui.primary, true), LinearLayout.LayoutParams(0, -2, 1f))
        val offline = Ui.text(this, "●  OFFLINE", 10f, Ui.primary, true).apply {
            background = Ui.background(Ui.mint, 30, context = this@MainActivity)
            setPadding(dp(12), dp(8), dp(12), dp(8))
            contentDescription = "Làm việc offline, dữ liệu trên điện thoại"
        }
        brandRow.addView(offline)
        root.addView(brandRow)
        root.addView(View(this).apply { setBackgroundColor(Ui.line) }, LinearLayout.LayoutParams(-1, dp(1)))
        content = FrameLayout(this)
        root.addView(content, LinearLayout.LayoutParams(-1, 0, 1f))
        status = Ui.text(this, "", 11f, Ui.muted).apply {
            gravity = Gravity.CENTER
            setPadding(dp(20), dp(7), dp(20), dp(7))
            visibility = View.GONE
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        root.addView(status)
        actions = Ui.row(this).apply { setPadding(dp(18), dp(12), dp(18), dp(14)); setBackgroundColor(Color.WHITE) }
        root.addView(actions)
        setContentView(root)
    }

    private fun requireRepository() = repository ?: error("Thư viện chưa sẵn sàng. Hãy mở lại ứng dụng.")

    private fun <T> work(label: String, block: () -> T, complete: (T) -> Unit) {
        if (!alive) return
        // Camera/file-picker results may arrive while the restored library is loading.
        if (busy) {
            pendingWork.addLast { work(label, block, complete) }
            return
        }
        busy = true
        status.text = label
        status.visibility = View.VISIBLE
        actions.isEnabled = false
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
        worker.execute {
            val result = runCatching(block)
            main.post {
                if (!alive) return@post
                busy = false
                actions.isEnabled = true
                window.clearFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
                status.visibility = View.GONE
                result.fold(complete) { error -> showError(error.message ?: "Không hoàn thành được thao tác. Vui lòng thử lại.") }
                if (!busy && pendingWork.isNotEmpty()) pendingWork.removeFirst().invoke()
            }
        }
    }

    private fun refresh() {
        if (repository == null || busy || !alive) return
        val generation = ++refreshGeneration
        worker.execute {
            val result = runCatching { requireRepository().listDocuments() }
            main.post {
                if (!alive || generation != refreshGeneration) return@post
                result.onSuccess { items ->
                    documents = items
                    if (items.none { it.id == documentId }) { documentId = null; pageId = null }
                    render()
                }.onFailure { showError(it.message ?: "Không đọc được thư viện.") }
            }
        }
    }

    private fun render() {
        content.removeAllViews()
        actions.removeAllViews()
        releaseBitmaps()
        val document = documents.find { it.id == documentId }
        if (document == null) renderLibrary() else renderDocument(document)
    }

    private fun renderLibrary() {
        val scroll = ScrollView(this).apply { isFillViewport = true }
        val body = Ui.column(this, 22)
        scroll.addView(body)
        content.addView(scroll)
        body.addView(Ui.text(this, "NHỮNG TRANG GIẤY, MỘT KHÔNG GIAN", 9f, Ui.muted, true))
        body.addView(Ui.spacer(this, 10))
        body.addView(Ui.text(this, "Thư viện của bạn.", 28f, Ui.ink, true))
        body.addView(Ui.spacer(this, 9))
        body.addView(Ui.text(this, "Quét, chỉnh và ghép PDF ngay trên điện thoại.", 12f, Ui.muted))
        body.addView(Ui.spacer(this, 23))
        val hero = Ui.column(this, 22).apply { background = Ui.background(Ui.mint, 18, context = this@MainActivity) }
        hero.addView(Ui.text(this, "TỪ MỘT LẦN CHỤP", 10f, Ui.primary, true))
        hero.addView(Ui.spacer(this, 13))
        hero.addView(Ui.text(this, "Đến một tài liệu\nthật chỉn chu.", 25f, Ui.ink, true))
        hero.addView(Ui.spacer(this, 12))
        hero.addView(Ui.text(this, "Camera để quét. Bốn góc để căn.\nMọi trang giấy gọn trong một tệp PDF.", 12f, Ui.muted))
        hero.addView(Ui.spacer(this, 18))
        hero.addView(Ui.button(this, "+  Bắt đầu quét", true) { createDialog(startCamera = true) })
        body.addView(hero)
        body.addView(Ui.spacer(this, 24))
        val count = documents.size
        val pages = documents.sumOf { it.pages.size }
        body.addView(Ui.text(this, "$count tài liệu  ·  $pages trang đã lưu", 12f, Ui.muted))
        body.addView(Ui.spacer(this, 15))
        val search = EditText(this).apply {
            hint = "Tìm tài liệu…"
            contentDescription = "Tìm tài liệu"
            textSize = 14f
            isSingleLine = true
            inputType = InputType.TYPE_CLASS_TEXT
            background = Ui.background(Color.WHITE, 12, Ui.line, this@MainActivity)
            setPadding(dp(14), dp(12), dp(14), dp(12))
            setText(query)
        }
        body.addView(search, LinearLayout.LayoutParams(-1, dp(49)))
        body.addView(Ui.spacer(this, 18))
        val list = Ui.column(this)
        body.addView(list)
        fun showCards() {
            list.removeAllViews()
            releaseBitmaps()
            val filtered = documents.filter { it.title.lowercase(Locale.ROOT).contains(query.lowercase(Locale.ROOT)) }
            if (filtered.isEmpty()) {
                val empty = Ui.column(this, 22).apply { gravity = Gravity.CENTER; background = Ui.background(Color.WHITE, 14, Ui.line, this@MainActivity) }
                empty.addView(Ui.text(this, if (query.isNotBlank()) "Chưa tìm thấy tài liệu" else "Trang đầu tiên đang chờ bạn.", 16f, Ui.ink, true))
                empty.addView(Ui.spacer(this, 9))
                empty.addView(Ui.text(this, if (query.isNotBlank()) "Thử tìm bằng một tên khác." else "Tạo tài liệu rồi chụp hoặc thêm ảnh có sẵn.", 12f, Ui.muted).apply { gravity = Gravity.CENTER })
                list.addView(empty)
            }
            for (item in filtered) {
                val card = Ui.row(this).apply {
                    setPadding(dp(14), dp(14), dp(14), dp(14))
                    background = Ui.background(Color.WHITE, 14, Ui.line, this@MainActivity)
                    isClickable = true
                    isFocusable = true
                    contentDescription = "Mở tài liệu ${item.title}, ${item.pages.size} trang"
                    setOnClickListener {
                        documentId = item.id; pageId = item.pages.firstOrNull()?.id; showingOriginal = false; render()
                    }
                }
                val cover = ImageView(this).apply {
                    scaleType = ImageView.ScaleType.FIT_CENTER
                    background = Ui.background(Ui.mint, 6, context = this@MainActivity)
                    setPadding(dp(5), dp(5), dp(5), dp(5))
                }
                card.addView(cover, LinearLayout.LayoutParams(dp(59), dp(76)))
                item.pages.firstOrNull()?.let { page -> loadBitmap({ requireRepository().imageFile(item.id, page.id) }, cover, 180) }
                val details = Ui.column(this).apply { setPadding(dp(14), 0, 0, 0) }
                details.addView(Ui.text(this, item.title, 15f, Ui.ink, true).apply { maxLines = 2 })
                details.addView(Ui.spacer(this, 7))
                details.addView(Ui.text(this, "${item.pages.size} trang · ${dateFormat.format(Date(item.updatedAt))}", 10f, Ui.muted))
                card.addView(details, LinearLayout.LayoutParams(0, -2, 1f))
                card.addView(Ui.text(this, "›", 28f, Ui.muted))
                list.addView(card)
                list.addView(Ui.spacer(this, 12))
            }
        }
        showCards()
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { query = s?.toString() ?: ""; showCards() }
            override fun afterTextChanged(s: Editable?) = Unit
        })
        body.addView(Ui.spacer(this, 12))
        body.addView(Ui.text(this, "Lưu trên điện thoại · Giữ riêng ảnh gốc", 11f, Ui.muted).apply { gravity = Gravity.CENTER })
        actions.addView(Ui.button(this, "+  Tài liệu mới", true) { createDialog() }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(Ui.button(this, "Hướng dẫn") { helpDialog() }, LinearLayout.LayoutParams(dp(110), -2).apply { marginStart = dp(10) })
    }

    private fun renderDocument(document: ScanDocument) {
        val body = Ui.column(this, 18)
        content.addView(body)
        val heading = Ui.row(this)
        heading.addView(Ui.button(this, "‹") { documentId = null; pageId = null; render() }.apply { contentDescription = "Về thư viện" }, LinearLayout.LayoutParams(dp(48), dp(48)))
        val titles = Ui.column(this).apply { setPadding(dp(12), 0, dp(7), 0) }
        titles.addView(Ui.text(this, document.title, 19f, Ui.ink, true).apply { maxLines = 2; setOnClickListener { renameDialog(document) }; contentDescription = "Đổi tên tài liệu ${document.title}" })
        titles.addView(Ui.spacer(this, 4))
        titles.addView(Ui.text(this, "Đã lưu · ${document.pages.size} trang", 11f, Ui.muted))
        heading.addView(titles, LinearLayout.LayoutParams(0, -2, 1f))
        heading.addView(Ui.button(this, "⋯") { documentMenu(document) }.apply { contentDescription = "Tùy chọn tài liệu" }, LinearLayout.LayoutParams(dp(48), dp(48)))
        body.addView(heading)
        body.addView(Ui.spacer(this, 18))
        if (document.pages.isEmpty()) {
            val empty = Ui.column(this, 25).apply { gravity = Gravity.CENTER; background = Ui.background(Ui.mint, 16, context = this@MainActivity) }
            empty.addView(Ui.text(this, "TRANG ĐẦU TIÊN", 10f, Ui.primary, true))
            empty.addView(Ui.spacer(this, 19))
            empty.addView(Ui.text(this, "Thêm chút giấy.\nTạo nên điều gọn gàng.", 24f, Ui.ink, true).apply { gravity = Gravity.CENTER })
            empty.addView(Ui.spacer(this, 15))
            empty.addView(Ui.text(this, "Chụp cả bốn góc trang giấy hoặc chọn ảnh từ thư viện điện thoại.", 13f, Ui.muted).apply { gravity = Gravity.CENTER })
            empty.addView(Ui.spacer(this, 24))
            empty.addView(Ui.button(this, "Quét bằng camera", true) { launchCamera(document.id) }, LinearLayout.LayoutParams(-1, -2))
            empty.addView(Ui.spacer(this, 12))
            empty.addView(Ui.button(this, "Thêm ảnh có sẵn") { launchGallery(document.id) }, LinearLayout.LayoutParams(-1, -2))
            body.addView(empty)
            body.addView(Ui.spacer(this, 20))
            body.addView(Ui.text(this, "Ảnh gốc và bản đã chỉnh luôn được lưu riêng.", 11f, Ui.muted).apply { gravity = Gravity.CENTER })
            actions.addView(Ui.button(this, "+  Thêm trang", true) { addPageDialog(document) }, LinearLayout.LayoutParams(-1, -2))
            return
        }
        val selected = document.pages.find { it.id == pageId } ?: document.pages.first()
        pageId = selected.id
        val index = document.pages.indexOf(selected)
        val selection = Ui.row(this)
        selection.addView(Ui.text(this, "Trang ${index + 1} / ${document.pages.size}", 12f, Ui.muted, true), LinearLayout.LayoutParams(0, -2, 1f))
        selection.addView(Ui.button(this, "‹") { pageId = document.pages[index - 1].id; showingOriginal = false; render() }.apply {
            isEnabled = index > 0; contentDescription = "Trang trước"
        }, LinearLayout.LayoutParams(dp(44), dp(44)))
        selection.addView(Ui.button(this, "›") { pageId = document.pages[index + 1].id; showingOriginal = false; render() }.apply {
            isEnabled = index < document.pages.lastIndex; contentDescription = "Trang sau"
        }, LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginStart = dp(7) })
        body.addView(selection)
        body.addView(Ui.spacer(this, 10))
        val preview = FrameLayout(this).apply { background = Ui.background(Color.rgb(231, 237, 223), 12, Ui.line, this@MainActivity); setPadding(dp(16), dp(16), dp(16), dp(16)) }
        val image = ImageView(this).apply { scaleType = ImageView.ScaleType.FIT_CENTER; contentDescription = if (showingOriginal) "Ảnh gốc trang ${index + 1}" else "Bản scan trang ${index + 1}" }
        preview.addView(image, FrameLayout.LayoutParams(-1, -1))
        val original = showingOriginal
        loadBitmap({ if (original) requireRepository().originalFile(document.id, selected.id) else requireRepository().imageFile(document.id, selected.id) }, image, 1400)
        body.addView(preview, LinearLayout.LayoutParams(-1, 0, 1f))
        body.addView(Ui.spacer(this, 12))
        val tools = Ui.row(this)
        tools.addView(Ui.button(this, if (showingOriginal) "Bản scan" else "Ảnh gốc") { showingOriginal = !showingOriginal; render() }, LinearLayout.LayoutParams(0, -2, 1f))
        tools.addView(Ui.button(this, "Chỉnh sửa", true) { launchEditor(document.id, selected.id) }, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = dp(9) })
        body.addView(tools)
        body.addView(Ui.spacer(this, 11))
        val pageOptions = Ui.row(this)
        pageOptions.addView(Ui.button(this, "↑") { movePage(document, index, index - 1) }.apply { isEnabled = index > 0; contentDescription = "Đưa trang lên" }, LinearLayout.LayoutParams(dp(49), dp(45)))
        pageOptions.addView(Ui.button(this, "↓") { movePage(document, index, index + 1) }.apply { isEnabled = index < document.pages.lastIndex; contentDescription = "Đưa trang xuống" }, LinearLayout.LayoutParams(dp(49), dp(45)).apply { marginStart = dp(8) })
        pageOptions.addView(Ui.text(this, "Đổi thứ tự trang", 11f, Ui.muted).apply { gravity = Gravity.CENTER }, LinearLayout.LayoutParams(0, -2, 1f))
        pageOptions.addView(Ui.button(this, "Xóa") { deletePageDialog(document, selected) }.apply { setTextColor(Ui.danger) }, LinearLayout.LayoutParams(dp(66), dp(45)))
        body.addView(pageOptions)
        actions.addView(Ui.button(this, "+  Thêm trang") { addPageDialog(document) }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(Ui.button(this, "Xuất PDF", true) { exportDialog(document) }, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = dp(10) })
    }

    private fun createDialog(startCamera: Boolean = false) {
        if (repository == null || busy) return
        val input = titleInput("Tài liệu ${SimpleDateFormat("dd/MM", Locale.getDefault()).format(Date())}")
        val dialog = AlertDialog.Builder(this).setTitle("Một tài liệu mới")
            .setMessage("Đặt tên để dễ tìm lại các trang đã quét.")
            .setView(input).setNegativeButton("Để sau", null).setPositiveButton("Tạo tài liệu", null).create()
        dialog.setOnShowListener {
            input.requestFocus(); input.selectAll()
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val title = input.text.toString().trim()
                if (title.isEmpty()) { input.error = "Hãy nhập tên tài liệu"; return@setOnClickListener }
                dialog.dismiss()
                work("Đang tạo tài liệu…", { requireRepository().createDocument(title) }) { document ->
                    documents = listOf(document) + documents
                    documentId = document.id; pageId = null; render()
                    if (startCamera) launchCamera(document.id)
                }
            }
        }
        dialog.show()
    }

    private fun titleInput(value: String) = EditText(this).apply {
        setText(value)
        hint = "Tên tài liệu"
        contentDescription = "Tên tài liệu"
        isSingleLine = true
        maxLines = 1
        filters = arrayOf(android.text.InputFilter.LengthFilter(160))
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        setPadding(dp(24), dp(14), dp(24), dp(14))
    }

    private fun renameDialog(document: ScanDocument) {
        val input = titleInput(document.title)
        val dialog = AlertDialog.Builder(this).setTitle("Đổi tên tài liệu").setView(input)
            .setNegativeButton("Hủy", null).setPositiveButton("Lưu tên", null).create()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val title = input.text.toString().trim()
            if (title.isEmpty()) { input.error = "Hãy nhập tên tài liệu"; return@setOnClickListener }
            dialog.dismiss()
            work("Đang lưu tên…", { requireRepository().renameDocument(document.id, title) }) { refresh() }
        } }
        dialog.show()
    }

    private fun addPageDialog(document: ScanDocument) {
        AlertDialog.Builder(this).setTitle("Thêm trang vào tài liệu")
            .setItems(arrayOf("Quét bằng camera", "Thêm ảnh có sẵn")) { _, which ->
                if (which == 0) launchCamera(document.id) else launchGallery(document.id)
            }.setNegativeButton("Hủy", null).show()
    }

    private fun launchCamera(target: String) {
        if (busy) return
        pendingCameraDocument = target
        camera.launch(Intent(this, CameraActivity::class.java))
    }

    private fun launchGallery(target: String) {
        if (busy) return
        pendingImportDocument = target
        gallery.launch(arrayOf("image/*"))
    }

    private fun launchEditor(target: String, selected: String) {
        editor.launch(Intent(this, EditActivity::class.java).putExtra("documentId", target).putExtra("pageId", selected))
    }

    private fun movePage(document: ScanDocument, from: Int, to: Int) {
        if (to !in document.pages.indices || from == to) return
        val order = document.pages.map { it.id }.toMutableList().apply { add(to, removeAt(from)) }
        work("Đang đổi thứ tự…", { requireRepository().reorderPages(document.id, order) }) { refresh() }
    }

    private fun deletePageDialog(document: ScanDocument, page: ScanPage) {
        AlertDialog.Builder(this).setTitle("Xóa trang này?")
            .setMessage("Ảnh gốc và bản chỉnh của trang sẽ được xóa. Thao tác không thể hoàn tác.")
            .setNegativeButton("Giữ lại", null).setPositiveButton("Xóa trang") { _, _ ->
                work("Đang xóa trang…", { requireRepository().deletePage(document.id, page.id) }) { refresh() }
            }.show()
    }

    private fun documentMenu(document: ScanDocument) {
        AlertDialog.Builder(this).setTitle(document.title)
            .setItems(arrayOf("Đổi tên tài liệu", "Sắp xếp các trang", "Xóa tài liệu")) { _, which ->
                when (which) {
                    0 -> renameDialog(document)
                    1 -> pagesDialog(document)
                    2 -> AlertDialog.Builder(this).setTitle("Xóa tài liệu?")
                        .setMessage("“${document.title}” và ${document.pages.size} trang sẽ được xóa. Thao tác không thể hoàn tác.")
                        .setNegativeButton("Giữ lại", null).setPositiveButton("Xóa tài liệu") { _, _ ->
                            work("Đang xóa tài liệu…", { requireRepository().deleteDocument(document.id) }) { documentId = null; pageId = null; refresh() }
                        }.show()
                }
            }.show()
    }

    private fun pagesDialog(document: ScanDocument) {
        if (document.pages.isEmpty()) { showError("Hãy thêm trang trước khi sắp xếp."); return }
        AlertDialog.Builder(this).setTitle("Chọn trang để xem và sắp xếp")
            .setItems(document.pages.mapIndexed { index, page -> "Trang ${index + 1} · ${page.width} × ${page.height}" }.toTypedArray()) { _, index ->
                pageId = document.pages[index].id; showingOriginal = false; render()
            }.setNegativeButton("Đóng", null).show()
    }

    private fun exportDialog(document: ScanDocument) {
        if (document.pages.isEmpty()) return
        var selectedPaper = 0
        AlertDialog.Builder(this).setTitle("Hoàn thiện ${document.pages.size} trang")
            .setSingleChoiceItems(arrayOf("Khổ A4 · để xem và in", "Theo tỷ lệ ảnh scan"), 0) { _, index -> selectedPaper = index }
            .setNegativeButton("Hủy", null)
            .setNeutralButton("Chia sẻ PDF") { _, _ ->
                val paper = if (selectedPaper == 0) PdfPaper.A4 else PdfPaper.IMAGE_RATIO
                work("Đang chuẩn bị PDF…", { requireRepository().exportPdf(document.id, paper) }) { file ->
                    val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
                    val share = Intent(Intent.ACTION_SEND).setType("application/pdf").putExtra(Intent.EXTRA_STREAM, uri)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).apply { clipData = ClipData.newRawUri("PDF", uri) }
                    try { startActivity(Intent.createChooser(share, "Chia sẻ tài liệu PDF")) }
                    catch (_: Exception) { showError("Chưa có ứng dụng nhận PDF. Bạn có thể chọn Lưu PDF.") }
                }
            }
            .setPositiveButton("Lưu PDF") { _, _ ->
                pendingExportDocument = document.id
                pendingExportPaper = if (selectedPaper == 0) PdfPaper.A4 else PdfPaper.IMAGE_RATIO
                savePdf.launch("${document.title.replace(Regex("[\\\\/:*?\"<>|]"), "_")}.pdf")
            }.show()
    }

    private fun openPdf(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/pdf")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).apply { clipData = ClipData.newRawUri("PDF", uri) })
        } catch (_: Exception) { showError("PDF đã được lưu. Hãy mở bằng ứng dụng đọc PDF trên điện thoại.") }
    }

    private fun helpDialog() {
        AlertDialog.Builder(this).setTitle("Ba bước, một tài liệu")
            .setMessage("1. Tạo tài liệu, chụp bằng camera hoặc thêm ảnh từ điện thoại.\n\n2. Chọn Chỉnh sửa. Kéo bốn góc theo mép giấy, xoay, chỉnh sáng và chọn bộ lọc. Lưu trang.\n\n3. Đổi thứ tự trang bằng ↑ ↓, rồi Xuất PDF để lưu hoặc chia sẻ.\n\nDữ liệu nằm trên điện thoại và dùng được offline. Ảnh gốc luôn được giữ riêng. Sao lưu PDF trước khi gỡ ứng dụng hoặc xóa dữ liệu ứng dụng.")
            .setPositiveButton("Đã hiểu", null).show()
    }

    private fun showError(message: String) {
        if (!alive) return
        AlertDialog.Builder(this).setTitle("myscan").setMessage(message).setPositiveButton("Đóng", null).show()
    }

    private fun loadBitmap(file: () -> File, target: ImageView, edge: Int) {
        worker.execute {
            val bitmap = runCatching {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                val path = file().absolutePath
                BitmapFactory.decodeFile(path, bounds)
                var sample = 1
                while (maxOf(bounds.outWidth, bounds.outHeight) / sample > edge * 2) sample *= 2
                BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
            }.getOrNull()
            main.post {
                if (alive && target.isAttachedToWindow) {
                    bitmap?.let { bitmaps += it; target.setImageBitmap(it) }
                    if (bitmap == null) {
                        target.contentDescription = "Không đọc được ảnh trang này"
                        status.text = "Không đọc được ảnh trang này. Hãy kiểm tra hoặc khôi phục tài liệu."
                        status.visibility = View.VISIBLE
                    }
                } else bitmap?.recycle()
            }
        }
    }

    private fun releaseBitmaps() {
        bitmaps.forEach { if (!it.isRecycled) it.recycle() }
        bitmaps.clear()
    }
}
