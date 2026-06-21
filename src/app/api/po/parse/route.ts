import { parseSheet, autoMapColumns, PO_FIELDS } from "@/lib/shiphero/parse";

// Parse an uploaded .xlsx/.csv into headers + rows + a best-guess column mapping.
// Conversion itself runs client-side (pure fn) so toggles re-preview instantly.
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "No file uploaded." }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const { headers, rows } = await parseSheet(buffer, file.name);

    if (headers.length === 0) {
      return Response.json({ error: "Could not read any columns from the file." }, { status: 400 });
    }

    const mapping = autoMapColumns(headers);
    return Response.json({
      filename: file.name,
      headers,
      rows,
      mapping,
      fields: PO_FIELDS,
      rowCount: rows.filter((r) => r.some((c) => String(c ?? "").trim() !== "")).length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to parse file.";
    return Response.json({ error: message }, { status: 500 });
  }
}
