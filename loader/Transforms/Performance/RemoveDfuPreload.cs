using System.Linq;
using org.objectweb.asm;
using org.objectweb.asm.tree;

internal class RemoveDfuPreloadTransform(string name, ClassWriter writer) : ClassNode(Opcodes.ASM9)
{
	public static IkvmClassLoaderTransformer Transformer = () => {
		return (["com.mojang.datafixers.DataFixerBuilder"], typeof(RemoveDfuPreloadTransform));
	};

	public override void visitEnd()
	{
		var build = methods.toArray().Cast<MethodNode>()
			.First(x => x.name == "build" && x.desc == "(Ljava/util/concurrent/Executor;)Lcom/mojang/datafixers/DataFixer;");
		var c = new JavaCursor(build);
		c.GotoNext(
			JavaMoveType.After,
			JavaMatch.InvokeSpecial(),
			JavaMatch.AStore(out var dfuLocal),
			JavaMatch.ALoad(dfuLocal));
		c.EmitAReturn();

		accept(writer);
	}
}
