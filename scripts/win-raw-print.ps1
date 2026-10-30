# Send one file to a Windows printer queue as RAW bytes.
#
# Why this exists:
#   Windows has no writable device node for USB printers (\\.\USB001 is not one),
#   and "print" / PrintDocument would run the driver, which re-encodes ESC/POS.
#   The spooler's RAW datatype passes the bytes through untouched, which is what
#   a receipt printer needs. StartDocPrinter(level 1, "RAW") is the only API for it.
#
# Usage (called by apps/server/src/print/transport.ts, WinSpoolChannel):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File win-raw-print.ps1 `
#       -Printer "XP-236B" -Path "C:\Temp\job.bin"
#
# Exit code 0 = queued. Non-zero = failure; stderr carries "CODE:win32error".
# This file stays ASCII on purpose: Windows PowerShell 5.1 reads BOM-less files
# as ANSI, and non-ASCII text here would turn into mojibake in error messages.

param(
  [Parameter(Mandatory = $true)][string]$Printer,
  [Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
  [Console]::Error.WriteLine('FILENOTFOUND:0')
  exit 11
}

$source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class XcRawPrint
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr handle);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool StartDocPrinter(IntPtr handle, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA info);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr handle);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr handle);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr handle);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr handle, IntPtr bytes, int count, out int written);

    public static string Send(string printer, string file)
    {
        IntPtr handle;
        if (!OpenPrinter(printer, out handle, IntPtr.Zero))
            return "OPENPRINTER:" + Marshal.GetLastWin32Error();

        try
        {
            var info = new DOCINFOA();
            info.pDocName = "Xiangcun Print";
            info.pDataType = "RAW";
            if (!StartDocPrinter(handle, 1, info))
                return "STARTDOC:" + Marshal.GetLastWin32Error();

            try
            {
                if (!StartPagePrinter(handle))
                    return "STARTPAGE:" + Marshal.GetLastWin32Error();

                byte[] bytes = File.ReadAllBytes(file);
                IntPtr buffer = Marshal.AllocCoTaskMem(bytes.Length);
                try
                {
                    Marshal.Copy(bytes, 0, buffer, bytes.Length);
                    int written;
                    if (!WritePrinter(handle, buffer, bytes.Length, out written))
                        return "WRITE:" + Marshal.GetLastWin32Error();
                    if (written != bytes.Length)
                        return "PARTIAL:" + written + "/" + bytes.Length;
                    return "OK";
                }
                finally
                {
                    Marshal.FreeCoTaskMem(buffer);
                }
            }
            finally
            {
                EndPagePrinter(handle);
                EndDocPrinter(handle);
            }
        }
        finally
        {
            ClosePrinter(handle);
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp
} catch {
  [Console]::Error.WriteLine('ADDTYPE:' + $_.Exception.Message)
  exit 12
}

$result = [XcRawPrint]::Send($Printer, $Path)

if ($result -ne 'OK') {
  [Console]::Error.WriteLine($result)
  exit 1
}

exit 0
