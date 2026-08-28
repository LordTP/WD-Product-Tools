import { parseSheet } from "@/lib/shiphero/parse";

export const dynamic = "force-dynamic";

// POST multipart { file } → the sheet as a string grid (headers + rows).
// Reuses the PO upload's parser; the date interpretation happens client-side
// (lib/po-dates-sheet) so paste and upload behave identically. Read-only.
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "No file uploaded." }, { status: 400 });
    if (file.size > 5 * 1024 * 1024) return Response.json({ error: "File is too big (5 MB max)." }, { status: 400 });
    const buffer = Buffer.from(await file.arrayBuffer());
    const { headers, rows } = await parseSheet(buffer, file.name);
    const grid = [headers, ...rows].map((r) => r.map((c) => String(c ?? "").trim()));
    return Response.json({ filename: file.name, grid });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Couldn't read that file." }, { status: 500 });
  }
}
