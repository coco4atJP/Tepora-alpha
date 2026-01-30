import ast
import os
import sys

def check_file(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception:
        return

    try:
        tree = ast.parse(content, filename=filepath)
    except SyntaxError:
        return

    rel_path = os.path.relpath(filepath, start=r'e:\Tepora_Project\Tepora-app')

    for node in ast.walk(tree):
        if isinstance(node, ast.ExceptHandler):
            # 1. Check exception type
            exc_type = "Specific"
            if node.type is None:
                exc_type = "Bare"
            elif isinstance(node.type, ast.Name):
                if node.type.id == 'Exception':
                    exc_type = "Exception"
                elif node.type.id == 'BaseException':
                    exc_type = "BaseException"
            
            # 2. Check if it re-raises
            has_raise = False
            has_log = False
            is_empty_or_pass = False
            
            # Simple check for simple bodies
            if not node.body:
                is_empty_or_pass = True
            elif len(node.body) == 1:
                stmt = node.body[0]
                if isinstance(stmt, ast.Pass):
                    is_empty_or_pass = True
                elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant) and stmt.value.value is Ellipsis:
                    is_empty_or_pass = True
            
            for child in node.body:
                for subnode in ast.walk(child):
                    if isinstance(subnode, ast.Raise):
                        has_raise = True
                    # Heuristic for logging
                    if isinstance(subnode, ast.Call):
                        if isinstance(subnode.func, ast.Attribute):
                             if subnode.func.attr in ['error', 'exception', 'critical', 'warning', 'info', 'debug']:
                                 has_log = True
                             # check for logger.xxx
                        elif isinstance(subnode.func, ast.Name):
                            if subnode.func.id == 'print':
                                has_log = True

            # Filter for "Bad" patterns
            # - Bare except (always bad if not re-raised)
            # - Exception/BaseException (bad if not re-raised)
            # - specific exceptions (bad if "passed", maybe okay if logged?)
            
            # User asked for "Exception suppression" e.g. pass or except Exception.
            
            report = False
            issue = ""
            
            if exc_type in ["Bare", "Exception", "BaseException"]:
                if not has_raise:
                    if is_empty_or_pass:
                        issue = "CRITICAL: Silent suppression (empty/pass)"
                        report = True
                    elif not has_log:
                        issue = "WARNING: Suppression without logging"
                        report = True
                    else:
                        # It is logged, but generic. User might still want to know.
                        issue = "INFO: Generic catch (logged but not re-raised)"
                        report = True
            else:
                # Specific exception
                if is_empty_or_pass:
                    issue = "WARNING: Specific exception silently ignored"
                    report = True
            
            if report:
                print(f"{rel_path}:{node.lineno} [{exc_type}] {issue}")

def main():
    start_path = r'e:\Tepora_Project\Tepora-app\backend'
    ignore_dirs = {'.venv', 'venv', 'env', '.git', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'node_modules', '.uv-cache', '.vscode'}
    
    for root, dirs, files in os.walk(start_path):
        # Modify dirs in-place to skip ignored directories
        dirs[:] = [d for d in dirs if d not in ignore_dirs]
        
        for file in files:
            if file.endswith('.py'):
                check_file(os.path.join(root, file))

if __name__ == '__main__':
    main()
