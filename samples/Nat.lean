/--
%%handwave
name:
  Addition associativity
statement:
  Addition of natural numbers is associative: $(a + b) + c = a + (b + c)$.
proof:
  This follows from the standard associativity theorem for natural addition.
-/
theorem my_add_assoc (a b c : Nat) :
    (a + b) + c = a + (b + c) := by
  exact Nat.add_assoc a b c

/--
%%handwave
name:
  Double
statement:
  Doubling a natural number means adding it to itself: $\operatorname{double}(n) = n + n$.
-/
def double (n : Nat) : Nat := n + n
