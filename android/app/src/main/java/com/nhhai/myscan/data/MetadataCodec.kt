package com.nhhai.myscan.data

import org.json.JSONArray
import org.json.JSONObject

/** Deliberately independent of Android so format validation can run on the JVM. */
internal object MetadataCodec {
    private const val VERSION = 1

    fun encode(documents: List<ScanDocument>): String {
        validateDocuments(documents)
        return JSONObject().put("schemaVersion", VERSION)
            .put("documents", JSONArray().apply { documents.forEach { put(encodeDocument(it)) } })
            .toString(2)
    }

    fun decode(text: String): List<ScanDocument> {
        val root = JSONObject(text)
        require(root.int("schemaVersion") == VERSION) { "Phiên bản thư viện chưa được hỗ trợ." }
        val values = root.getJSONArray("documents")
        val result = (0 until values.length()).map { decodeDocument(values.getJSONObject(it)) }
        validateDocuments(result)
        return result
    }

    private fun validateDocuments(documents: List<ScanDocument>) {
        require(documents.map { it.id }.distinct().size == documents.size) { "Mã tài liệu bị trùng." }
        val pageIds = documents.flatMap { it.pages }.map { it.id }
        require(pageIds.distinct().size == pageIds.size) { "Mã trang bị trùng trong thư viện." }
        documents.forEach { document ->
            // Recheck a supplied read-only List even if its backing collection changed since construction.
            document.copy(pages = document.pages.toList())
            document.pages.forEach { it.edit?.validate() }
        }
    }

    private fun encodeDocument(document: ScanDocument) = JSONObject()
        .put("id", document.id).put("title", document.title)
        .put("createdAt", document.createdAt).put("updatedAt", document.updatedAt)
        .put("pages", JSONArray().apply { document.pages.forEach { put(encodePage(it)) } })

    private fun encodePage(page: ScanPage) = JSONObject()
        .put("id", page.id).put("width", page.width).put("height", page.height)
        .put("originalWidth", page.originalWidth).put("originalHeight", page.originalHeight)
        .put("createdAt", page.createdAt).put("updatedAt", page.updatedAt)
        .put("edit", page.edit?.let { settings ->
            JSONObject().put("rotation", settings.rotation).put("mode", settings.mode.name)
                .put("brightness", settings.brightness.toDouble()).put("contrast", settings.contrast.toDouble())
                .put("corners", JSONArray().apply {
                    settings.corners.forEach { point ->
                        put(JSONObject().put("x", point.x.toDouble()).put("y", point.y.toDouble()))
                    }
                })
        } ?: JSONObject.NULL)

    private fun decodeDocument(value: JSONObject) = ScanDocument(
        id = value.string("id"), title = value.string("title"),
        createdAt = value.long("createdAt"), updatedAt = value.long("updatedAt"),
        pages = value.getJSONArray("pages").let { values ->
            (0 until values.length()).map { decodePage(values.getJSONObject(it)) }
        },
    )

    private fun decodePage(value: JSONObject) = ScanPage(
        id = value.string("id"), width = value.int("width"), height = value.int("height"),
        originalWidth = value.int("originalWidth"), originalHeight = value.int("originalHeight"),
        createdAt = value.long("createdAt"), updatedAt = value.long("updatedAt"),
        edit = if (!value.has("edit") || value.isNull("edit")) null else decodeSettings(value.getJSONObject("edit")),
    )

    private fun decodeSettings(value: JSONObject) = EditSettings(
        rotation = value.int("rotation"), mode = ColorMode.valueOf(value.string("mode")),
        brightness = value.float("brightness"), contrast = value.float("contrast"),
        corners = value.getJSONArray("corners").let { values ->
            (0 until values.length()).map { index ->
                val point = values.getJSONObject(index)
                ScanPoint(point.float("x"), point.float("y"))
            }
        },
    )

    private fun JSONObject.string(name: String): String {
        val value = get(name)
        require(value is String) { "Trường $name phải là chuỗi." }
        return value
    }

    private fun JSONObject.long(name: String): Long {
        val value = get(name)
        require(value is Number) { "Trường $name phải là số nguyên." }
        return value.toString().toLongOrNull() ?: throw IllegalArgumentException("Trường $name phải là số nguyên.")
    }

    private fun JSONObject.int(name: String): Int {
        val value = long(name)
        require(value in Int.MIN_VALUE..Int.MAX_VALUE) { "Trường $name quá lớn." }
        return value.toInt()
    }

    private fun JSONObject.float(name: String): Float {
        val value = get(name)
        require(value is Number) { "Trường $name phải là số." }
        return value.toFloat().also { require(it.isFinite()) { "Trường $name không hữu hạn." } }
    }
}
