using System.Linq;
using org.objectweb.asm;
using org.objectweb.asm.tree;

public static class IkvmKnotBridge
{
	public static byte[] Transform(java.lang.ClassLoader loader, string name, byte[] array)
	{
		return IkvmClassLoader.LatestInstance.TransformClassBytecode(loader, name, array);
	}

	public static void OnClassDefined(java.lang.Class klass)
	{
		_ = klass;
	}
}

internal class InjectIkvmIntoKnotTransform(string name, ClassWriter writer) : ClassNode(Opcodes.ASM9)
{
	public static IkvmClassLoaderTransformer Transformer = () => {
		return (["net.fabricmc.loader.impl.launch.knot.KnotClassDelegate"], typeof(InjectIkvmIntoKnotTransform));
	};

	public override void visitEnd()
	{
		var tryLoadClass = methods.toArray().Cast<MethodNode>()
			.First(x => x.name == "tryLoadClass" && x.desc == "(Ljava/lang/String;Z)Ljava/lang/Class;");

		var c = new JavaCursor(tryLoadClass);
		c.GotoNext(
			JavaMoveType.After,
			JavaMatch.ALoad(out var nameLocal),
			JavaMatch.ILoad(),
			JavaMatch.InvokeSpecial(null, "getPostMixinClassByteArray", "(Ljava/lang/String;Z)[B"),
			JavaMatch.AStore(out var bytearrayLocal));

		var skip = new LabelNode();
		c.EmitALoad(bytearrayLocal);
		c.EmitJump(Opcodes.IFNULL, skip);
		c.EmitALoad(0);
		c.EmitField(Opcodes.GETFIELD, "net/fabricmc/loader/impl/launch/knot/KnotClassDelegate", "classLoader", "Ljava/lang/ClassLoader;");
		c.EmitALoad(nameLocal);
		c.EmitALoad(bytearrayLocal);
		c.EmitMethod(Opcodes.INVOKESTATIC, "cli/IkvmKnotBridge", "Transform", "(Ljava/lang/ClassLoader;Ljava/lang/String;[B)[B");
		c.EmitAStore(bytearrayLocal);
		c.EmitLabel(skip);

		c.GotoNext(
			JavaMoveType.After,
			JavaMatch.Method(Opcodes.INVOKEINTERFACE,
				"net/fabricmc/loader/impl/launch/knot/KnotClassDelegate$ClassLoaderAccess",
				"defineClassFwd",
				"(Ljava/lang/String;[BIILjava/security/CodeSource;)Ljava/lang/Class;", true));
		c.Emit(Opcodes.DUP);
		c.EmitMethod(Opcodes.INVOKESTATIC, "cli/IkvmKnotBridge", "OnClassDefined", "(Ljava/lang/Class;)V");

		accept(writer);
	}
}
