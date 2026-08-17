$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WinSqliteQuery {
  const int SQLITE_OPEN_READONLY = 0x00000001;
  const int SQLITE_OPEN_URI = 0x00000040;
  const int SQLITE_ROW = 100;
  const int SQLITE_DONE = 101;
  const int SQLITE_INTEGER = 1;
  const int SQLITE_FLOAT = 2;
  const int SQLITE_TEXT = 3;
  const int SQLITE_NULL = 5;

  [DllImport("winsqlite3", EntryPoint="sqlite3_open_v2", CallingConvention=CallingConvention.Cdecl)]
  static extern int sqlite3_open_v2(byte[] filename, out IntPtr db, int flags, IntPtr vfs);
  [DllImport("winsqlite3", EntryPoint="sqlite3_close", CallingConvention=CallingConvention.Cdecl)]
  static extern int sqlite3_close(IntPtr db);
  [DllImport("winsqlite3", EntryPoint="sqlite3_busy_timeout", CallingConvention=CallingConvention.Cdecl)]
  static extern int sqlite3_busy_timeout(IntPtr db, int ms);
  [DllImport("winsqlite3", EntryPoint="sqlite3_prepare_v2", CallingConvention=CallingConvention.Cdecl)]
  static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int nByte, out IntPtr stmt, IntPtr tail);
  [DllImport("winsqlite3", EntryPoint="sqlite3_step", CallingConvention=CallingConvention.Cdecl)]
  static extern int sqlite3_step(IntPtr stmt);
  [DllImport("winsqlite3", EntryPoint="sqlite3_finalize", CallingConvention=CallingConvention.Cdecl)]
  static extern int sqlite3_finalize(IntPtr stmt);
  [DllImport("winsqlite3", EntryPoint="sqlite3_column_count", CallingConvention=CallingConvention.Cdecl)]
  static extern int sqlite3_column_count(IntPtr stmt);
  [DllImport("winsqlite3", EntryPoint="sqlite3_column_name", CallingConvention=CallingConvention.Cdecl)]
  static extern IntPtr sqlite3_column_name(IntPtr stmt, int iCol);
  [DllImport("winsqlite3", EntryPoint="sqlite3_column_type", CallingConvention=CallingConvention.Cdecl)]
  static extern int sqlite3_column_type(IntPtr stmt, int iCol);
  [DllImport("winsqlite3", EntryPoint="sqlite3_column_int64", CallingConvention=CallingConvention.Cdecl)]
  static extern long sqlite3_column_int64(IntPtr stmt, int iCol);
  [DllImport("winsqlite3", EntryPoint="sqlite3_column_double", CallingConvention=CallingConvention.Cdecl)]
  static extern double sqlite3_column_double(IntPtr stmt, int iCol);
  [DllImport("winsqlite3", EntryPoint="sqlite3_column_text", CallingConvention=CallingConvention.Cdecl)]
  static extern IntPtr sqlite3_column_text(IntPtr stmt, int iCol);
  [DllImport("winsqlite3", EntryPoint="sqlite3_errmsg", CallingConvention=CallingConvention.Cdecl)]
  static extern IntPtr sqlite3_errmsg(IntPtr db);

  static string PtrToUtf8(IntPtr p) {
    if (p == IntPtr.Zero) return null;
    int len = 0;
    while (Marshal.ReadByte(p, len) != 0) len++;
    byte[] buf = new byte[len];
    Marshal.Copy(p, buf, 0, len);
    return Encoding.UTF8.GetString(buf);
  }

  static string JsonEscape(string s) {
    if (s == null) return "";
    StringBuilder sb = new StringBuilder();
    foreach (char c in s) {
      if (c == '\\') sb.Append("\\\\");
      else if (c == '"') sb.Append("\\\"");
      else if (c == '\n') sb.Append("\\n");
      else if (c == '\r') sb.Append("\\r");
      else if (c == '\t') sb.Append("\\t");
      else if (c < 32) sb.AppendFormat("\\u{0:x4}", (int)c);
      else sb.Append(c);
    }
    return sb.ToString();
  }

  public static string Query(string dbPath, string sql) {
    string uri = "file:" + dbPath.Replace("\\", "/") + "?mode=ro";
    byte[] dbBytes = Encoding.UTF8.GetBytes(uri + "\0");
    IntPtr db;
    int rc = sqlite3_open_v2(dbBytes, out db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, IntPtr.Zero);
    if (rc != 0) {
      string err = PtrToUtf8(sqlite3_errmsg(db));
      sqlite3_close(db);
      throw new Exception(err ?? ("sqlite open failed " + rc));
    }
    sqlite3_busy_timeout(db, 8000);
    byte[] sqlBytes = Encoding.UTF8.GetBytes(sql + "\0");
    IntPtr stmt;
    rc = sqlite3_prepare_v2(db, sqlBytes, -1, out stmt, IntPtr.Zero);
    if (rc != 0) {
      string err = PtrToUtf8(sqlite3_errmsg(db));
      sqlite3_close(db);
      throw new Exception(err ?? ("sqlite prepare failed " + rc));
    }
    StringBuilder json = new StringBuilder();
    json.Append("[");
    bool firstRow = true;
    int colCount = sqlite3_column_count(stmt);
    string[] names = new string[colCount];
    for (int i = 0; i < colCount; i++) names[i] = PtrToUtf8(sqlite3_column_name(stmt, i));
    while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
      if (!firstRow) json.Append(",");
      firstRow = false;
      json.Append("{");
      bool firstCol = true;
      for (int i = 0; i < colCount; i++) {
        int type = sqlite3_column_type(stmt, i);
        if (type != SQLITE_INTEGER && type != SQLITE_FLOAT && type != SQLITE_TEXT && type != SQLITE_NULL) continue;
        if (!firstCol) json.Append(",");
        firstCol = false;
        json.Append("\"");
        json.Append(JsonEscape(names[i]));
        json.Append("\":");
        if (type == SQLITE_NULL) json.Append("null");
        else if (type == SQLITE_INTEGER) json.Append(sqlite3_column_int64(stmt, i).ToString());
        else if (type == SQLITE_FLOAT) json.Append(sqlite3_column_double(stmt, i).ToString(System.Globalization.CultureInfo.InvariantCulture));
        else {
          json.Append("\"");
          json.Append(JsonEscape(PtrToUtf8(sqlite3_column_text(stmt, i)) ?? ""));
          json.Append("\"");
        }
      }
      json.Append("}");
    }
    sqlite3_finalize(stmt);
    sqlite3_close(db);
    if (rc != SQLITE_DONE) throw new Exception("sqlite step failed " + rc);
    json.Append("]");
    return json.ToString();
  }
}
'@

$spec = Get-Content -Raw -Encoding UTF8 $args[0] | ConvertFrom-Json
if ($null -ne $spec.queries) {
  $chunks = New-Object System.Collections.Generic.List[string]
  foreach ($prop in $spec.queries.PSObject.Properties) {
    $rows = [WinSqliteQuery]::Query($spec.db, [string]$prop.Value)
    $chunks.Add(('"{0}":{1}' -f $prop.Name, $rows))
  }
  Write-Output ('{' + ($chunks -join ',') + '}')
} else {
  [WinSqliteQuery]::Query($spec.db, $spec.sql)
}
