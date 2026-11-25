using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.OutputVisitor;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;
using System.Reflection.Metadata.Ecma335;

return;

public static partial class Decompiler
{
    static readonly DecompilerSettings Settings = new();
    static readonly InMemoryResolver Resolver = new();
    static CSharpDecompiler? decompiler;
    /// Decompilers for types defined outside the main assembly, by defining file.
    static readonly Dictionary<string, CSharpDecompiler> others = [];

    [JSExport]
    public static void AddAssembly(string fileName, byte[] bytes) => Resolver.Add(fileName, bytes);

    /// Loads the main assembly; returns the file names of all assemblies its type system resolved, as a JSON array.
    [JSExport]
    public static async Task<string> Load(string mainFileName)
    {
        var main = Resolver.Find(Path.GetFileNameWithoutExtension(mainFileName))
            ?? throw new FileNotFoundException(mainFileName);
        // the synchronous CSharpDecompiler constructors block on a task, which single-threaded wasm cannot do
        var typeSystem = await DecompilerTypeSystem.CreateAsync(main, Resolver, Settings);
        decompiler = new CSharpDecompiler(typeSystem, Settings);
        others.Clear();
        var used = typeSystem.Modules
            .Select(m => m.MetadataFile?.FileName)
            .OfType<string>()
            .ToArray();
        return JsonSerializer.Serialize(used, Json.Default.StringArray);
    }

    /// Returns `{ source, members: [{ name, line }], tokens }` as JSON for a type of any assembly the main one references;
    /// `line` is 1-based, `tokens` see `HighlightWriter`.
    [JSExport]
    public static async Task<string> DecompileType(string fullName)
    {
        if (decompiler is null) throw new InvalidOperationException("no assembly loaded");
        var name = new FullTypeName(fullName);
        var file = decompiler.TypeSystem.FindType(name).GetDefinition()?.ParentModule?.MetadataFile
            ?? throw new ArgumentException($"type {fullName} not found in the loaded assemblies");
        var owner = file == decompiler.TypeSystem.MainModule.MetadataFile ? decompiler : await DecompilerFor(file);
        var tree = owner.DecompileType(name);
        var writer = new StringWriter();
        var text = new TextWriterTokenWriter(writer) { IndentationString = "\t" };
        var highlight = new HighlightWriter(text);
        tree.AcceptVisitor(new CSharpOutputVisitor(
            TokenWriter.InsertRequiredSpaces(TokenWriter.WrapInWriterThatSetsLocationsInAST(highlight)),
            Settings.CSharpFormattingOptions));
        var symbols = highlight.Symbols;
        var members = tree.Descendants.SelectMany(n => MembersOf(n, symbols)).ToArray();
        return JsonSerializer.Serialize(
            new DecompiledType(writer.ToString(), members, highlight.Tokens.ToArray(), symbols.Types.ToArray(), symbols.Pairs.ToArray()),
            Json.Default.DecompiledType);
    }

    static async Task<CSharpDecompiler> DecompilerFor(MetadataFile file)
    {
        if (others.TryGetValue(file.FileName, out var d)) return d;
        if (file is not PEFile pe) throw new NotSupportedException($"{file.FileName} is not a PE file");
        var typeSystem = await DecompilerTypeSystem.CreateAsync(pe, Resolver, Settings);
        return others[file.FileName] = new CSharpDecompiler(typeSystem, Settings);
    }

    static IEnumerable<Member> MembersOf(AstNode node, SymbolTable symbols) => node switch
    {
        Accessor => [],
        // `int a, b;` declares several members in one node
        FieldDeclaration f => f.Variables.Select(v => new Member(v.Name, v.StartLocation.Line, symbols.Id(v))),
        EventDeclaration e => e.Variables.Select(v => new Member(v.Name, v.StartLocation.Line, symbols.Id(v))),
        EntityDeclaration d => [new Member(d.Name, (d.NameToken?.StartLocation ?? d.StartLocation).Line, symbols.Id(d))],
        _ => [],
    };
}

/// Resolves references by simple assembly name; unresolvable ones degrade the output instead of failing.
sealed class InMemoryResolver : IAssemblyResolver
{
    readonly Dictionary<string, (string FileName, byte[] Bytes)> files = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, PEFile> opened = new(StringComparer.OrdinalIgnoreCase);

    public void Add(string fileName, byte[] bytes) => files[Path.GetFileNameWithoutExtension(fileName)] = (fileName, bytes);

    public PEFile? Find(string name)
    {
        if (opened.TryGetValue(name, out var file)) return file;
        if (!files.TryGetValue(name, out var f)) return null;
        return opened[name] = new PEFile(f.FileName, new MemoryStream(f.Bytes));
    }

    public MetadataFile? Resolve(IAssemblyReference reference) => Find(reference.Name);
    public MetadataFile? ResolveModule(MetadataFile mainModule, string moduleName) => Find(Path.GetFileNameWithoutExtension(moduleName));
    public Task<MetadataFile?> ResolveAsync(IAssemblyReference reference) => Task.FromResult(Resolve(reference));
    public Task<MetadataFile?> ResolveModuleAsync(MetadataFile mainModule, string moduleName) => Task.FromResult(ResolveModule(mainModule, moduleName));
    public IDisposable? BeginSnapshot() => null;
}

/// Numbers the entities a type's tokens refer to as `(type index, metadata token)`; id 0 means none.
sealed class SymbolTable
{
    public readonly List<string> Types = [];
    public readonly List<int> Pairs = [];
    readonly Dictionary<string, int> typeIds = [];
    readonly Dictionary<(int, int), int> ids = [];

    public int Id(AstNode? node)
    {
        if (Entity(node) is not { } def) return 0;
        var typeName = def.DeclaringTypeDefinition?.ReflectionName ?? def.ReflectionName;
        if (!typeIds.TryGetValue(typeName, out var type))
        {
            typeIds[typeName] = type = Types.Count;
            Types.Add(typeName);
        }
        var key = (type, MetadataTokens.GetToken(def.MetadataToken));
        if (ids.TryGetValue(key, out var id)) return id;
        Pairs.AddRange([key.Item1, key.Item2]);
        return ids[key] = Pairs.Count / 2;
    }

    public static IEntity? Entity(AstNode? node) => node switch
    {
        AstType t => t.GetSymbol()?.GetDefinition(),
        // a call's resolved method is annotated on the invocation, not on its target
        Expression { Parent: InvocationExpression call } e when call.Target == e => Entity(call),
        _ => node?.GetSymbol() switch
        {
            IMember m => m.MemberDefinition,
            ITypeDefinition d => d,
            _ => null,
        },
    };
}

/// Records highlighted tokens as `[gap, length, kind, symbol]`; `gap` counts characters since the previous token's end.
sealed class HighlightWriter(TextWriterTokenWriter inner) : DecoratingTokenWriter(inner), ILocatable
{
    public enum Kind { Keyword, Type, Method, Member, String, Number, Comment }

    public readonly List<int> Tokens = [];
    public readonly SymbolTable Symbols = new();
    int end;

    public TextLocation Location => inner.Location;
    public int Length => inner.Length;

    void Record(Kind? kind, Action write, int symbol = 0)
    {
        var start = inner.Length;
        write();
        if (kind is not { } k || inner.Length == start) return;
        Tokens.AddRange([start - end, inner.Length - start, (int)k, symbol]);
        end = inner.Length;
    }

    public override void WriteKeyword(string keyword) => Record(Kind.Keyword, () => base.WriteKeyword(keyword));
    public override void WritePrimitiveType(string type) => Record(Kind.Keyword, () => base.WritePrimitiveType(type));
    public override void WriteInterpolatedText(string text) => Record(Kind.String, () => base.WriteInterpolatedText(text));
    public override void WriteComment(CommentType type, string content) => Record(Kind.Comment, () => base.WriteComment(type, content));

    public override void WritePrimitiveValue(object? value, LiteralFormat format = LiteralFormat.None) =>
        Record(value switch
        {
            string or char => Kind.String,
            null or bool => Kind.Keyword,
            _ => Kind.Number,
        }, () => base.WritePrimitiveValue(value, format));

    public override void WriteIdentifier(Identifier identifier) =>
        Record(Classify(identifier.Parent), () => base.WriteIdentifier(identifier), Symbols.Id(identifier.Parent));

    static Kind? Classify(AstNode? node) => node switch
    {
        AstType or TypeDeclaration or DelegateDeclaration or ConstructorDeclaration or DestructorDeclaration => Kind.Type,
        _ => SymbolTable.Entity(node) switch
        {
            IType => Kind.Type,
            IMethod { IsConstructor: true } => Kind.Type,
            IMethod => Kind.Method,
            IField or IProperty or IEvent => Kind.Member,
            _ => null,
        },
    };
}

public record Member(string Name, int Line, int Symbol);

public record DecompiledType(string Source, Member[] Members, int[] Tokens, string[] SymbolTypes, int[] Symbols);

[System.Text.Json.Serialization.JsonSourceGenerationOptions(PropertyNamingPolicy = System.Text.Json.Serialization.JsonKnownNamingPolicy.CamelCase)]
[System.Text.Json.Serialization.JsonSerializable(typeof(DecompiledType))]
[System.Text.Json.Serialization.JsonSerializable(typeof(string[]))]
internal partial class Json : System.Text.Json.Serialization.JsonSerializerContext;
