from sqlalchemy.dialects.postgresql import ARRAY, TSVECTOR
from sqlalchemy.ext.compiler import compiles


@compiles(TSVECTOR, "sqlite")
def compile_tsvector(element, compiler, **kw) -> str:
    return "TEXT"


@compiles(ARRAY, "sqlite")
def compile_array(element, compiler, **kw) -> str:
    return "JSON"
