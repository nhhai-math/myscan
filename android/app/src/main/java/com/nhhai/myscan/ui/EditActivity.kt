package com.nhhai.myscan.ui

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.nhhai.myscan.data.ColorMode
import com.nhhai.myscan.data.EditSettings
import com.nhhai.myscan.data.ScanRepository
import com.nhhai.myscan.image.ScanEditorView
import com.nhhai.myscan.image.ScanGeometry
import com.nhhai.myscan.image.ScanImageProcessor
import java.util.ArrayDeque
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import kotlin.math.roundToInt

/** Offline, non-destructive page editing. The repository always retains the original. */
class EditActivity : ComponentActivity() {
    companion object {
        const val EXTRA_DOCUMENT_ID = "documentId"
        const val EXTRA_PAGE_ID = "pageId"
        fun intent(context: Context, documentId: String, pageId: String): Intent =
            Intent(context, EditActivity::class.java).putExtra(EXTRA_DOCUMENT_ID, documentId).putExtra(EXTRA_PAGE_ID, pageId)
    }

    private val worker = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var repository: ScanRepository
    private lateinit var documentId: String
    private lateinit var pageId: String
    private lateinit var imageView: ScanEditorView
    private lateinit var status: TextView
    private lateinit var saveButton: Button
    private lateinit var undoButton: Button
    private lateinit var cropButton: Button
    private lateinit var previewButton: Button
    private lateinit var brightnessBar: SeekBar
    private lateinit var contrastBar: SeekBar
    private lateinit var brightnessLabel: TextView
    private lateinit var contrastLabel: TextView
    private val modeButtons = mutableMapOf<ColorMode, Button>()
    private val controls = mutableListOf<View>()
    private val undoHistory = ArrayDeque<EditSettings>()
    private var settings = EditSettings()
    private var source: Bitmap? = null
    private var preview: Bitmap? = null
    private var cropping = true
    private var loading = true
    private var saving = false
    private var syncingControls = false
    @Volatile private var alive = true
    @Volatile private var previewGeneration = 0L
    private var pendingPreview: Runnable? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        documentId = intent.getStringExtra(EXTRA_DOCUMENT_ID).orEmpty()
        pageId = intent.getStringExtra(EXTRA_PAGE_ID).orEmpty()
        if (documentId.isBlank() || pageId.isBlank()) { finish(); return }
        buildUi()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (saving) Toast.makeText(this@EditActivity, "Đang lưu trang…", Toast.LENGTH_SHORT).show()
                else finish()
            }
        })
        worker.execute {
            try {
                repository = ScanRepository(applicationContext)
                val page = repository.getDocument(documentId)?.pages?.firstOrNull { it.id == pageId }
                    ?: error("Không tìm thấy trang cần chỉnh sửa.")
                val loaded = ScanImageProcessor.loadOriented(repository.originalFile(documentId, pageId),
                    ScanImageProcessor.PREVIEW_MAX_EDGE)
                val initial = page.edit ?: EditSettings()
                mainHandler.post {
                    if (!alive) { loaded.recycle(); return@post }
                    source = loaded
                    settings = initial.copy(corners = initial.corners.toList())
                    if (savedInstanceState != null && savedInstanceState.getBoolean("hasDraft", false)) {
                        restoreDraft(savedInstanceState)
                    }
                    loading = false
                    syncControls()
                    showImage()
                    schedulePreview()
                }
            } catch (error: Exception) { reportError(error, fatal = true) }
        }
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()
    private val teal = Color.rgb(12, 111, 92)
    private val ink = Color.rgb(22, 54, 50)

    private fun background(color: Int, radius: Int = 12) = GradientDrawable().apply {
        setColor(color); cornerRadius = dp(radius).toFloat()
    }

    private fun label(text: String, size: Float = 14f, bold: Boolean = false): TextView = TextView(this).apply {
        this.text = text; textSize = size; setTextColor(ink)
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    private fun button(text: String, action: () -> Unit): Button = Button(this).apply {
        this.text = text; isAllCaps = false; textSize = 13f; minHeight = dp(48)
        setTextColor(teal); background = background(Color.WHITE)
        setPadding(dp(8), 0, dp(8), 0)
        setOnClickListener { action() }
        controls.add(this)
    }

    private fun row(vararg buttons: View): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        buttons.forEach { view -> addView(view, LinearLayout.LayoutParams(0, dp(48), 1f).apply {
            marginEnd = dp(4); marginStart = dp(4)
        }) }
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setBackgroundColor(Color.rgb(242, 249, 245))
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(dp(12) + bars.left, dp(8) + bars.top, dp(12) + bars.right, dp(8) + bars.bottom)
            insets
        }
        val titleRow = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        titleRow.addView(button("‹ Quay lại") { onBackPressedDispatcher.onBackPressed() },
            LinearLayout.LayoutParams(dp(96), dp(48)))
        titleRow.addView(label("Chỉnh ảnh quét", 19f, true), LinearLayout.LayoutParams(0, dp(48), 1f).apply {
            marginStart = dp(8)
        })
        saveButton = button("Lưu trang") { save() }.apply {
            background = background(teal); setTextColor(Color.WHITE)
        }
        titleRow.addView(saveButton, LinearLayout.LayoutParams(dp(96), dp(48)))
        root.addView(titleRow)
        status = label("Đang mở ảnh gốc…", 12f).apply {
            setPadding(dp(4), dp(8), dp(4), dp(8))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        root.addView(status)
        imageView = ScanEditorView(this).apply {
            onGestureStarted = { rememberUndo() }
            onCornersChanged = { corners -> settings = settings.copy(corners = corners); schedulePreview() }
        }
        root.addView(imageView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        cropButton = button("1 · Cắt & căn trang") { cropping = true; syncControls(); showImage() }
        previewButton = button("2 · Xem kết quả") { cropping = false; syncControls(); showImage() }
        root.addView(row(cropButton, previewButton), LinearLayout.LayoutParams(-1, dp(56)).apply {
            topMargin = dp(8)
        })

        val editControls = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        undoButton = button("Hoàn tác") {
            if (undoHistory.isNotEmpty()) {
                settings = undoHistory.removeLast(); syncControls(); showImage(); schedulePreview()
            }
        }
        editControls.addView(row(button("Xoay 90°") {
            rememberUndo(); settings = settings.copy(rotation = ScanGeometry.normalizedRotation(settings.rotation + 90))
            syncControls(); showImage(); schedulePreview()
        }, undoButton, button("Ảnh gốc") {
            rememberUndo(); settings = EditSettings(); syncControls(); showImage(); schedulePreview()
        }))
        val modes = listOf(ColorMode.COLOR to "Màu", ColorMode.GRAYSCALE to "Thang xám", ColorMode.BLACK_WHITE to "Đen trắng")
        modes.forEach { (mode, title) -> modeButtons[mode] = button(title) {
            if (settings.mode != mode) {
                rememberUndo(); settings = settings.copy(mode = mode)
                cropping = false; syncControls(); showImage(); schedulePreview()
            }
        } }
        editControls.addView(row(*modeButtons.values.toTypedArray()), LinearLayout.LayoutParams(-1, dp(56)).apply {
            topMargin = dp(4)
        })
        brightnessLabel = label("Độ sáng · 0%", 12f)
        brightnessBar = slider(100, 50) { progress ->
            settings = settings.copy(brightness = (progress - 50) / 100f)
            brightnessLabel.text = "Độ sáng · ${(settings.brightness * 100).roundToInt()}%"
            brightnessBar.contentDescription = "Độ sáng, ${(settings.brightness * 100).roundToInt()} phần trăm"
        }
        contrastLabel = label("Tương phản · 100%", 12f)
        contrastBar = slider(150, 50) { progress ->
            settings = settings.copy(contrast = .5f + progress / 100f)
            contrastLabel.text = "Tương phản · ${(settings.contrast * 100).roundToInt()}%"
            contrastBar.contentDescription = "Tương phản, ${(settings.contrast * 100).roundToInt()} phần trăm"
        }
        val sliders = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        listOf(brightnessLabel to brightnessBar, contrastLabel to contrastBar).forEach { (caption, slider) ->
            sliders.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(6), dp(8), dp(6), 0)
                addView(caption); addView(slider, LinearLayout.LayoutParams(-1, dp(48)))
            }, LinearLayout.LayoutParams(0, -2, 1f))
        }
        editControls.addView(sliders)
        root.addView(ScrollView(this).apply {
            isFillViewport = true; addView(editControls)
        }, LinearLayout.LayoutParams(-1, dp(186)))
        setContentView(root)
        syncControls()
    }

    private fun slider(maximum: Int, initial: Int, update: (Int) -> Unit): SeekBar = SeekBar(this).apply {
        max = maximum; progress = initial
        controls.add(this)
        setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onStartTrackingTouch(seekBar: SeekBar) { rememberUndo() }
            override fun onStopTrackingTouch(seekBar: SeekBar) { schedulePreview() }
            override fun onProgressChanged(seekBar: SeekBar, progress: Int, fromUser: Boolean) {
                if (!fromUser || syncingControls) return
                update(progress)
                cropping = false
                styleTabs()
                showImage()
                schedulePreview()
            }
        })
    }

    private fun rememberUndo() {
        if (loading || saving) return
        undoHistory.addLast(settings.copy(corners = settings.corners.toList()))
        while (undoHistory.size > 24) undoHistory.removeFirst()
        undoButton.isEnabled = true
    }

    private fun syncControls() {
        syncingControls = true
        controls.forEach { it.isEnabled = !loading && !saving }
        undoButton.isEnabled = !loading && !saving && undoHistory.isNotEmpty()
        imageView.editable = !loading && !saving
        brightnessBar.progress = ((settings.brightness * 100).roundToInt() + 50).coerceIn(0, 100)
        contrastBar.progress = ((settings.contrast - .5f) * 100).roundToInt().coerceIn(0, 150)
        brightnessLabel.text = "Độ sáng · ${(settings.brightness * 100).roundToInt()}%"
        contrastLabel.text = "Tương phản · ${(settings.contrast * 100).roundToInt()}%"
        brightnessBar.contentDescription = "Độ sáng, ${(settings.brightness * 100).roundToInt()} phần trăm"
        contrastBar.contentDescription = "Tương phản, ${(settings.contrast * 100).roundToInt()} phần trăm"
        modeButtons.forEach { (mode, button) -> styleSelection(button, settings.mode == mode) }
        styleTabs()
        syncingControls = false
    }

    private fun styleSelection(button: Button, selected: Boolean) {
        button.background = background(if (selected) Color.rgb(203, 240, 221) else Color.WHITE)
        button.setTextColor(teal)
        button.isSelected = selected
    }

    private fun styleTabs() {
        styleSelection(cropButton, cropping)
        styleSelection(previewButton, !cropping)
        status.text = if (cropping) "Kéo bốn góc theo mép giấy để cắt và căn thẳng trang."
            else "Bản xem trước · ảnh gốc luôn được giữ lại."
    }

    private fun showImage() {
        if (cropping) imageView.setSource(source, settings.rotation, settings.corners)
        else imageView.setPreview(preview)
    }

    private fun schedulePreview() {
        if (loading || saving || source == null || !alive) return
        previewGeneration++
        pendingPreview?.let { mainHandler.removeCallbacks(it) }
        val generation = previewGeneration
        val snapshot = settings.copy(corners = settings.corners.toList())
        val input = source ?: return
        pendingPreview = Runnable {
            if (!alive) return@Runnable
            worker.execute {
                if (!alive || generation != previewGeneration) return@execute
                try {
                    val rendered = ScanImageProcessor.process(input, snapshot, ScanImageProcessor.PREVIEW_MAX_EDGE)
                    mainHandler.post {
                        if (!alive || generation != previewGeneration) { rendered.recycle(); return@post }
                        val previous = preview
                        preview = rendered
                        if (!cropping) imageView.setPreview(rendered)
                        previous?.recycle()
                    }
                } catch (error: Exception) {
                    if (alive && generation == previewGeneration) reportError(error)
                }
            }
        }.also { mainHandler.postDelayed(it, 85) }
    }

    private fun save() {
        if (loading || saving || !ScanGeometry.validate(settings.corners)) return
        saving = true
        previewGeneration++
        pendingPreview?.let { mainHandler.removeCallbacks(it) }
        val snapshot = settings.copy(corners = settings.corners.toList())
        syncControls()
        status.text = "Đang lưu trang hoàn thiện…"
        worker.execute {
            var original: Bitmap? = null
            var edited: Bitmap? = null
            try {
                original = ScanImageProcessor.loadOriented(repository.originalFile(documentId, pageId))
                edited = ScanImageProcessor.process(original, snapshot)
                repository.saveEditedPage(documentId, pageId, edited, snapshot)
                mainHandler.post {
                    if (!alive) return@post
                    setResult(Activity.RESULT_OK)
                    finish()
                }
            } catch (error: Exception) {
                mainHandler.post {
                    if (!alive) return@post
                    saving = false
                    syncControls()
                    status.text = error.message ?: "Không lưu được trang. Vui lòng thử lại."
                    schedulePreview()
                }
            } finally {
                edited?.recycle()
                original?.recycle()
            }
        }
    }

    private fun reportError(error: Exception, fatal: Boolean = false) {
        mainHandler.post {
            if (!alive) return@post
            status.text = error.message ?: "Không xử lý được ảnh."
            Toast.makeText(this, status.text, Toast.LENGTH_LONG).show()
            if (fatal) finish()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("hasDraft", !loading)
        outState.putInt("rotation", settings.rotation)
        outState.putString("colorMode", settings.mode.name)
        outState.putFloat("brightness", settings.brightness)
        outState.putFloat("contrast", settings.contrast)
        outState.putFloatArray("corners", settings.corners.flatMap { listOf(it.x, it.y) }.toFloatArray())
        outState.putBoolean("cropping", cropping)
        super.onSaveInstanceState(outState)
    }

    private fun restoreDraft(state: Bundle) {
        val coords = state.getFloatArray("corners")
        val corners = if (coords?.size == 8) List(4) {
            com.nhhai.myscan.data.ScanPoint(coords[it * 2], coords[it * 2 + 1])
        } else settings.corners
        if (!ScanGeometry.validate(corners)) return
        val rotation = state.getInt("rotation", settings.rotation)
        if (rotation % 90 != 0) return
        settings = settings.copy(rotation = ScanGeometry.normalizedRotation(rotation), corners = corners,
            mode = runCatching { ColorMode.valueOf(state.getString("colorMode").orEmpty()) }.getOrDefault(settings.mode),
            brightness = state.getFloat("brightness", settings.brightness).coerceIn(-1f, 1f),
            contrast = state.getFloat("contrast", settings.contrast).coerceIn(.25f, 3f))
        cropping = state.getBoolean("cropping", true)
    }

    override fun onDestroy() {
        alive = false
        previewGeneration++
        pendingPreview?.let { mainHandler.removeCallbacks(it) }
        if (::imageView.isInitialized) imageView.setPreview(null)
        preview?.recycle()
        preview = null
        // Cleanup follows any accepted save or preview task, so their input cannot be recycled early.
        try { worker.execute { source?.recycle(); source = null } } catch (_: RejectedExecutionException) { }
        worker.shutdown()
        super.onDestroy()
    }
}
