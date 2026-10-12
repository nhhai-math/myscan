package com.nhhai.myscan.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MetadataCodecTest {
    private val documentId = "00000000-0000-0000-0000-000000000001"
    private val secondDocumentId = "00000000-0000-0000-0000-000000000002"
    private val pageId = "00000000-0000-0000-0000-000000000003"
    private val page = ScanPage(
        pageId, 1800, 2400, 2400, 3200, 1000L, 2000L,
        EditSettings(
            rotation = 90,
            corners = listOf(ScanPoint(.05f, .06f), ScanPoint(.94f, .03f), ScanPoint(.98f, .92f), ScanPoint(.08f, .99f)),
            mode = ColorMode.GRAYSCALE, brightness = .12f, contrast = 1.3f,
        ),
    )
    private val document = ScanDocument(documentId, "Đề Toán 12 · Lớp 12A1", 1000L, 2000L, listOf(page))

    @Test fun roundTripRetainsVietnameseTitleOriginalDimensionsAndEditSettings() {
        assertEquals(listOf(document), MetadataCodec.decode(MetadataCodec.encode(listOf(document))))
    }

    @Test fun emptyLibraryIsExplicitlyEncodedAndDecoded() {
        val json = MetadataCodec.encode(emptyList())
        assertEquals(emptyList<ScanDocument>(), MetadataCodec.decode(json))
        assertEquals(1, JSONObject(json).getInt("schemaVersion"))
    }

    @Test fun originalPageWithoutEditsRoundTrips() {
        val unedited = document.copy(pages = listOf(page.copy(edit = null)))
        assertEquals(listOf(unedited), MetadataCodec.decode(MetadataCodec.encode(listOf(unedited))))
    }

    @Test fun malformedAndMissingMetadataAreRejected() {
        listOf("", "{", "{}", "{\"documents\":[]}", "{\"schemaVersion\":1,\"documents\":null}").forEach { json ->
            assertThrows(Exception::class.java) { MetadataCodec.decode(json) }
        }
    }

    @Test fun unknownSchemaIsRejected() {
        val json = JSONObject(MetadataCodec.encode(listOf(document))).put("schemaVersion", 2)
        val error = assertThrows(IllegalArgumentException::class.java) { MetadataCodec.decode(json.toString()) }
        assertTrue(error.message.orEmpty().contains("Phiên bản"))
    }

    @Test fun duplicateDocumentsOrPagesAcrossDocumentsAreRejected() {
        assertThrows(IllegalArgumentException::class.java) { MetadataCodec.encode(listOf(document, document)) }
        assertThrows(IllegalArgumentException::class.java) {
            MetadataCodec.encode(listOf(document, document.copy(id = secondDocumentId)))
        }
        val json = JSONObject(MetadataCodec.encode(listOf(document)))
        json.getJSONArray("documents").put(JSONObject(json.getJSONArray("documents").getJSONObject(0).toString()))
        assertThrows(IllegalArgumentException::class.java) { MetadataCodec.decode(json.toString()) }
    }

    @Test fun maliciousPathsAndInvalidPageDimensionsAreRejected() {
        listOf("../outside", "00000000/../0000", "NOT-A-UUID").forEach { id ->
            val json = JSONObject(MetadataCodec.encode(listOf(document)))
            json.getJSONArray("documents").getJSONObject(0).put("id", id)
            assertThrows(IllegalArgumentException::class.java) { MetadataCodec.decode(json.toString()) }
        }
        val json = JSONObject(MetadataCodec.encode(listOf(document)))
        json.page().put("width", 0)
        assertThrows(IllegalArgumentException::class.java) { MetadataCodec.decode(json.toString()) }
    }

    @Test fun coercedStringsAndFractionalTimestampsAreRejected() {
        val numericString = JSONObject(MetadataCodec.encode(listOf(document)))
        numericString.page().put("width", "1800")
        assertThrows(IllegalArgumentException::class.java) { MetadataCodec.decode(numericString.toString()) }
        val fractionalTime = JSONObject(MetadataCodec.encode(listOf(document)))
        fractionalTime.page().put("updatedAt", 2000.5)
        assertThrows(IllegalArgumentException::class.java) { MetadataCodec.decode(fractionalTime.toString()) }
    }

    @Test fun invalidSavedColorOrCornersAreRejected() {
        val unknownColor = JSONObject(MetadataCodec.encode(listOf(document)))
        unknownColor.page().getJSONObject("edit").put("mode", "INVALID")
        assertThrows(IllegalArgumentException::class.java) { MetadataCodec.decode(unknownColor.toString()) }
        val corners = JSONObject(MetadataCodec.encode(listOf(document)))
        corners.page().getJSONObject("edit").getJSONArray("corners").getJSONObject(0).put("x", -0.1)
        assertThrows(IllegalArgumentException::class.java) { MetadataCodec.decode(corners.toString()) }
    }

    private fun JSONObject.page(): JSONObject = getJSONArray("documents").getJSONObject(0).getJSONArray("pages").getJSONObject(0)
}
