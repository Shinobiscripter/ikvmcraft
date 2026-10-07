using System;
using System.Text;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Reflection;
using System.Threading;
using System.IO;
using System.IO.Hashing;

using java.lang;
using java.util;
using java.util.concurrent.atomic;
using org.objectweb.asm;
using jvmdg = xyz.wagyourtail.jvmdg;

internal class RawResourceReader(IkvmClassLoader owner) : jvmdg.util.Function
{
	private static readonly byte[] Missing = [];
	private readonly ConcurrentDictionary<string, byte[]> cache = new();

	public object apply(object s)
	{
		var bytes = cache.GetOrAdd((string)s + ".class", Read);
		return ReferenceEquals(bytes, Missing) ? null : bytes;
	}

	private byte[] Read(string resource)
	{
		var stream = owner.getResourceAsStream(resource);
		if (stream is null) return Missing;
		try
		{
			var output = new java.io.ByteArrayOutputStream();
			var buffer = new byte[8192];
			int n;
			while ((n = stream.read(buffer)) > 0) output.write(buffer, 0, n);
			return output.toByteArray();
		}
		finally { stream.close(); }
	}
}

// blob format: [blobCount 1 byte] [ushort nameLen 2 bytes][name][int length 4 bytes][blob] ...
// index format: [xxhash128 16 bytes][offset 8 bytes] ...
class DowngradeCache
{
	private readonly FileStream BlobReader;
	private readonly FileStream BlobWriter;
	private readonly FileStream Index;

	private readonly Lock WriteLock = new();
	private readonly ConcurrentDictionary<UInt128, long> IndexParsed;

	internal DowngradeCache(string folder)
	{
		if (!Directory.Exists(folder))
			Directory.CreateDirectory(folder);

		var cacheBlob = folder + "/cache.blob";
		var cacheIndex = folder + "/cache.index";

		IndexParsed = File.Exists(cacheIndex) ? ParseIndex(File.ReadAllBytes(cacheIndex)) : new();

		BlobReader = new(cacheBlob, FileMode.OpenOrCreate, FileAccess.Read, FileShare.ReadWrite);
		BlobWriter = new(cacheBlob, FileMode.Open, FileAccess.Write, FileShare.ReadWrite);
		BlobWriter.Seek(0, SeekOrigin.End);

		Index = new(cacheIndex, FileMode.OpenOrCreate, FileAccess.Write, FileShare.Write);
		Index.Seek(0, SeekOrigin.End);
	}

	private static ConcurrentDictionary<UInt128, long> ParseIndex(byte[] bytearr)
	{
		ConcurrentDictionary<UInt128, long> index = [];

		ReadOnlySpan<byte> bytes = bytearr;
		for (int i = 0; i < bytes.Length; i += 24)
		{
			if (bytes.Length < i + 24)
				break;

			var hash = BitConverter.ToUInt128(bytes.Slice(i, 16));
			var offset = BitConverter.ToInt64(bytes.Slice(i + 16, 8));

			index.TryAdd(hash, offset);
		}

		return index;
	}

	internal bool Get(byte[] bytes, out Dictionary<string, byte[]> cached)
	{
		var hash = XxHash128.HashToUInt128(bytes);

		if (IndexParsed.TryGetValue(hash, out var offset))
		{
			lock (BlobReader)
			{
				BlobReader.Seek(offset, SeekOrigin.Begin);
				BinaryReader reader = new(BlobReader);

				cached = [];

				var len = reader.ReadByte();
				for (int i = 0; i < len; i++)
				{
					var klassLen = reader.ReadUInt16();
					var klass = Encoding.UTF8.GetString(reader.ReadBytes(klassLen));
					var codeLen = reader.ReadInt32();
					var code = reader.ReadBytes(codeLen);

					cached.Add(klass, code);
				}

				return true;
			}
		}

		cached = null;
		return false;
	}

	internal void Add(byte[] before, Dictionary<string, byte[]> after)
	{
		var hash = XxHash128.HashToUInt128(before);

		lock (WriteLock)
		{
			if (IndexParsed.ContainsKey(hash))
				return;

			var offset = BlobWriter.Position;
			if (after.Count > 255) throw new OverflowException("downgrade had too many classes");

			BlobWriter.WriteByte((byte)after.Count);
			foreach (var (key, val) in after)
			{
				var utf8 = Encoding.UTF8.GetBytes(key);
				BlobWriter.Write(BitConverter.GetBytes((ushort)utf8.Length));
				BlobWriter.Write(utf8);
				BlobWriter.Write(BitConverter.GetBytes(val.Length));
				BlobWriter.Write(val);
			}
			BlobWriter.Flush();

			IndexParsed.TryAdd(hash, offset);
			Index.Write(BitConverter.GetBytes(hash));
			Index.Write(BitConverter.GetBytes(offset));
			Index.Flush();
		}
	}
}

internal class IkvmJvmDowngrader
{
	[DllImport("Emscripten")]
	private static extern void classloader_debug([MarshalAs(UnmanagedType.LPUTF8Str)] string log);

	private readonly static MethodInfo DefineClass = typeof(ClassLoader).GetMethod("defineClass", BindingFlags.NonPublic | BindingFlags.Instance, [typeof(string), typeof(byte[]), typeof(int), typeof(int)]);

	private readonly jvmdg.ClassDowngrader Downgrader;
	private readonly RawResourceReader DowngraderResReader;

	private readonly DowngradeCache Cache;

	internal IkvmJvmDowngrader(IkvmClassLoader classLoader, string cacheFolder)
	{
		var flags = new jvmdg.cli.Flags
		{
			classVersion = Opcodes.V1_8,
			allowMaven = false
		};
		Downgrader = jvmdg.ClassDowngrader.downgradeTo(flags);
		DowngraderResReader = new(classLoader);

		Cache = new(cacheFolder);
	}

	private static Dictionary<string, byte[]> GetDict(Map map)
	{
		if (map == null) return null;

		Dictionary<string, byte[]> dict = [];

		foreach (var _entry in map.entrySet().toArray())
		{
			var entry = (Map.Entry)_entry;
			var key = (string)entry.getKey();
			var val = (byte[])entry.getValue();

			if (key.StartsWith("META-INF/versions")) continue;
			dict.Add(key, val);
		}

		return dict;
	}

	private (Dictionary<string, byte[]>, bool) CachedDowngrade(string internalName, byte[] bytes)
	{
		if (Cache.Get(bytes, out var cached))
			return (cached, true);
		else
		{
			AtomicReference nameRef = new(internalName);
			var outputs = GetDict(Downgrader.downgrade(nameRef, bytes, true, DowngraderResReader));

			if (outputs != null)
				Cache.Add(bytes, outputs);

			return (outputs, false);
		}
	}

	internal byte[] Downgrade(ClassLoader loader, string name, byte[] bytes)
	{
		var internalName = name.Replace(".", "/");
		var (outputs, cached) = CachedDowngrade(internalName, bytes);

		if (outputs != null)
		{
			if (!outputs.ContainsKey(internalName))
			{
				throw new ClassNotFoundException("removed by jvmdowngrader");
			}

			classloader_debug($"[IkvmJvmDowngrader] '{name}' downgraded" + (cached ? " (cached)" : ""));
			foreach (var (key, val) in outputs)
			{
				if (key == internalName)
				{
					bytes = val;
					continue;
				}

				DefineClass.Invoke(loader, [key.Replace("/", "."), val, 0, val.Length]);
			}
		}

		return bytes;
	}
}
