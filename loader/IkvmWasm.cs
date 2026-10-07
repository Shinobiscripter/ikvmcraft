using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.JavaScript;

struct Dll
{
    public string RealName;
    public string MappedName;
}

static partial class IkvmWasm
{
    [DllImport("Emscripten")]
    static internal extern void ikvm_gl_init(int backend);

    internal static void Main()
    {
        Console.WriteLine(":3");
    }

    public static string[][] ConvertJSObjectToStringArray(JSObject jsObject)
    {
        // Get the JS Array length
        var outerLength = jsObject.GetPropertyAsInt32("length");
        var result = new string[outerLength][];

        for (int i = 0; i < outerLength; i++)
        {
            using var innerArray = jsObject.GetPropertyAsJSObject(i.ToString());
            var innerLength = innerArray.GetPropertyAsInt32("length");
            result[i] = new string[innerLength];

            for (int j = 0; j < innerLength; j++)
            {
                result[i][j] = innerArray.GetPropertyAsString(j.ToString()) ?? string.Empty;
            }
        }

        return result;
    }

    private static void MountDlls(string root, string[] rawDlls)
    {
        IEnumerable<Dll> dlls = rawDlls.Select(x =>
        {
            var split = x.Split('|');
            return new Dll() { RealName = split[0], MappedName = split[1] };
        });

        Directory.CreateDirectory("/dlls");
		Emscripten.MountFetch(1, root + "_framework/", "/fetchdlls/");
        foreach (var dll in dlls)
        {
            Emscripten.MountFetchFile(1, $"/fetchdlls/{dll.RealName}");
			File.CreateSymbolicLink($"/dlls/{dll.MappedName}", $"/fetchdlls/{dll.RealName}");
        }
    }
    [JSExport]
    internal static Task PreInit(int glBackend, string fetchbase, string[] rawDlls, JSObject props)
    {
        try
        {
            Emscripten.InstallThreadLogForwarder();

            Emscripten.MountOpfs();

            Emscripten.MountFetch(0, fetchbase + "/image", "/ikvm");
            Emscripten.MountFetchDir(0, "/ikvm/bin");
            Emscripten.MountFetchFile(0, "/ikvm/bin/libzip.so");
            Emscripten.MountFetchFile(0, "/ikvm/bin/libnio.so");
            Emscripten.MountFetchFile(0, "/ikvm/bin/libnet.so");
            Emscripten.MountFetchFile(0, "/ikvm/bin/libmanagement.so");
            Emscripten.MountFetchFile(0, "/ikvm/bin/libawt.so");
            Emscripten.MountFetchFile(0, "/ikvm/bin/libfontmanager.so");
            Emscripten.MountFetchFile(0, "/ikvm/bin/libmlib_image.so");
            Emscripten.MountFetchFile(0, "/ikvm/bin/liblcms.so");
            Emscripten.MountFetchFile(0, "/ikvm/bin/libjpeg.so");
            Emscripten.MountFetchDir(0, "/ikvm/lib");
            Emscripten.MountFetchFile(0, "/ikvm/lib/currency.data");
            Emscripten.MountFetchFile(0, "/ikvm/lib/tzdb.dat");
            Emscripten.MountFetchFile(0, "/ikvm/lib/content-types.properties");
            Emscripten.MountFetchFile(0, "/ikvm/lib/logging.properties");

			MountDlls(fetchbase, rawDlls);

            ikvm_gl_init(glBackend);

            Directory.CreateDirectory("/tmp/lwjgl");
            File.WriteAllText("/tmp/lwjgl/liblwjgl.so", "");
            File.WriteAllText("/tmp/lwjgl/liblwjgl_opengl.so", "");
            File.WriteAllText("/tmp/lwjgl/liblwjgl_stb.so", "");
            File.WriteAllText("/tmp/lwjgl/liblwjgl_tinyfd.so", "");
            File.WriteAllText("/tmp/lwjgl/libffi.so", "");
            File.WriteAllText("/tmp/lwjgl/libglfw.so", "");
            File.WriteAllText("/tmp/lwjgl/libopenal.so", "");
            File.WriteAllText("/tmp/lwjgl/libfreetype.so", "");
            File.WriteAllText("/tmp/lwjgl/libGL.so.1", "");

            File.WriteAllText("/ikvm.properties", "ikvm.home=/ikvm");

            // -- ikvm will init after this --
            var bootstrapDlls = IkvmcManifest.LoadEmbedded().AlwaysReplaceDlls();
            java.lang.Thread.currentThread().setContextClassLoader(new IkvmClassLoader([], bootstrapDlls, []));

            java.lang.System.setProperty("org.lwjgl.system.allocator", "system");
            java.lang.System.setProperty("org.lwjgl.system.SharedLibraryExtractPath", "/tmp/lwjgl");
            java.lang.System.setProperty("org.lwjgl.librarypath", "/tmp/lwjgl");
            java.lang.System.setProperty("log4j2.contextSelector", "org.apache.logging.log4j.core.selector.BasicContextSelector");

            foreach (var prop in ConvertJSObjectToStringArray(props))
            {
                Console.WriteLine($"-D{prop[0]}={prop[1]}");
                java.lang.System.setProperty(prop[0], prop[1]);
            }

			IkvmNameService.Install();
			IkvmSocketService.Install();

            return Task.CompletedTask;
        }
        catch (Exception e)
        {
            ExceptionLogging.WriteException(e, "Error in PreInit()!");
            return Task.FromException(e);
        }
    }

    [JSExport]
    internal static Task Run(string version)
    {
        try
        {
            Console.WriteLine($"[IKVM] running mc {version}");

            MinecraftLauncher.LaunchVanilla(new()
            {
                VersionJsonPath = $"/libsdl/ikvmcraft/versions/{version}/version.json",
                VersionJarPath = $"/libsdl/ikvmcraft/versions/{version}/client.jar",
				ClientMappingsPath = $"/libsdl/ikvmcraft/versions/{version}/client.txt",
                LibraryDirectoryPath = "/libsdl/ikvmcraft/libraries/",
                AssetsRootPath = "/libsdl/ikvmcraft/assets/",
                GameDirectoryPath = "/libsdl/minecraft/",
                MinecraftOsName = "Emscripten",
				PlayerName = "ikvmcraft",
                AsmTransformers =
                [
					InjectIkvmIntoKnotTransform.Transformer,
					SwapNettyBackendTransform.Transformer,

					ThereAreNoBareClientsTransform.Transformer,

					FixCrashReportTransform.Transformer,

					//RemoveDfuPreloadTransform.Transformer,
				],
            });

            return Task.CompletedTask;
        }
        catch (Exception e)
        {
            ExceptionLogging.WriteException(e, "[IKVM] Run failed");
            return Task.FromException(e);
        }
    }

    [JSExport]
    internal static Task RunJar(string jarPath, string mainclass)
    {
        try
        {
            Console.WriteLine($"[IKVM] running jar {jarPath}");
            var mainClassName = mainclass ?? GetMainClassName(jarPath);
            Console.WriteLine($"[IKVM] main class: {mainClassName}");

            var mainClass = java.lang.Class.forName(mainClassName, true, java.lang.Thread.currentThread().getContextClassLoader());
            var stringArrayClass = java.lang.Class.forName("[Ljava.lang.String;");
            var mainMethod = mainClass.getMethod("main", [stringArrayClass]);
            mainMethod.invoke(null, [Array.Empty<string>()]);
            return Task.CompletedTask;
        }
        catch (Exception e)
        {
            ExceptionLogging.WriteException(e, "[IKVM] Run failed");
            return Task.FromException(e);
        }
    }

    private static string GetMainClassName(string jarPath)
    {
        var jar = new java.util.jar.JarFile(jarPath);
        var manifest = jar.getManifest() ?? throw new InvalidDataException($"Jar has no manifest: {jarPath}");

        var mainClass = manifest.getMainAttributes()?.getValue(java.util.jar.Attributes.Name.MAIN_CLASS);
        if (string.IsNullOrWhiteSpace(mainClass))
        {
            throw new InvalidDataException($"Jar manifest missing Main-Class: {jarPath}");
        }

        return mainClass.Trim();
    }

    [JSExport]
    internal static Task WatchMemoryUsage(int delay, [JSMarshalAs<JSType.Function<JSType.Number, JSType.Boolean>>] Func<double, bool> callback)
    {
        return Task.Run(async () =>
        {
            while (true)
            {
				var info = GC.GetGCMemoryInfo();
                bool stop = callback((double)info.TotalCommittedBytes / (1024 * 1024));
				if (stop) break;
                await Task.Delay(delay);
            }
        });
    }
}
