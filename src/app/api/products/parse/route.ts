import { parseStyleArcade } from "@/lib/styleArcade/parse";
import { resolveColumns, analyze } from "@/lib/styleArcade/convert";

// POST /api/products/parse — parse a Style Arcade .xlsx, resolve columns, and
// return the data + analysis. The CSV is built client-side (pure fn) so the A/B
// scenario toggle re-generates instantly.
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "No file uploaded." }, { status: 400 });
    if (file.name.toLowerCase().endsWith(".csv")) {
      return Response.json({ error: "Style Arcade exports are .xlsx — please upload the Excel file." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const { sheetName, headers, rows } = await parseStyleArcade(buffer);
    const { cols, missing } = resolveColumns(headers);
    const analysis = analyze(rows, cols);

    return Response.json({ filename: file.name, sheetName, headers, rows, cols, missing, analysis });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to parse file.";
    return Response.json({ error: message }, { status: 500 });
  }
}
